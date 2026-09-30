<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type {
  FieldIdentifyLog,
  FieldNote,
  FieldSporePrint,
  IdConfidence,
  SporeColor
} from '@/types'
import { ID_CONFIDENCES, SPORE_COLORS } from '@/types'
import { useStore } from '@/hooks/usePersistentStore'
import { fieldStore } from '@/stores/fieldStore'
import { mergeJobStore, LARGE_BATCH_THRESHOLD } from '@/stores/mergeStore'
import { pointStore } from '@/stores/pointStore'
import { uid } from '@/utils/id'

const fieldState = useStore(fieldStore)
const jobState = useStore(mergeJobStore)
const pointState = useStore(pointStore)

const today = new Date().toISOString().slice(0, 10)

/* ---------------- 手记登记 ---------------- */
const form = reactive({
  tempName: '',
  pointId: '',
  collectDate: '2026-08-01',
  collector: '沈禾',
  hostTree: '',
  sporeColor: '白色' as SporeColor,
  withSpore: true,
  conclusion: '',
  confidence: '低' as IdConfidence,
  needReview: true
})

const selected = ref<string[]>([])

function pointCode(pointId: string): string {
  return pointState.points.find((point) => point.id === pointId)?.code ?? '—'
}
function pointName(pointId: string): string {
  return pointState.points.find((point) => point.id === pointId)?.name ?? '未关联采集点'
}

const pendingNotes = computed(() => fieldState.notes.filter((note) => note.status === 'pending'))
const mergedNotes = computed(() => fieldState.notes.filter((note) => note.status === 'merged'))

function sporeOf(noteId: string): FieldSporePrint | undefined {
  return fieldState.spores.find((item) => item.noteId === noteId)
}
function identifyOf(noteId: string): FieldIdentifyLog | undefined {
  return fieldState.identifies.find((item) => item.noteId === noteId)
}

async function addNote(): Promise<void> {
  if (!form.pointId) {
    ElMessage.warning('请选择采集点')
    return
  }
  const seq = fieldState.notes.length + 1
  const noteId = uid('fnt')
  const note: FieldNote = {
    id: noteId,
    tempCode: `TMP-${String(seq).padStart(4, '0')}`,
    tempName: form.tempName.trim() || `外业条目 ${seq}`,
    fruitBodyCount: 1,
    pointId: form.pointId,
    capDiameter: 5,
    capShape: '平展',
    capMargin: '全缘',
    capTexture: '光滑',
    fleshThickness: 1,
    fleshReaction: '不变色',
    attachment: '离生',
    gillDensity: '中等',
    stipeLength: 5,
    stipeDiameter: 1,
    ring: '无菌环',
    volva: '无菌托',
    odor: '',
    hostTree: form.hostTree.trim(),
    collectDate: form.collectDate,
    collector: form.collector.trim(),
    note: '外业手记，仅临时编号',
    status: 'pending',
    createdAt: today
  }
  await fieldStore.getState().saveNote(note)
  if (form.withSpore) {
    await fieldStore.getState().saveSpore({
      id: uid('fsp'),
      noteId,
      color: form.sporeColor,
      shape: '圆形印痕',
      hours: 8,
      observeDate: form.collectDate,
      moisture: '新鲜样本'
    })
  }
  if (form.conclusion.trim()) {
    await fieldStore.getState().saveIdentify({
      id: uid('fid'),
      noteId,
      conclusion: form.conclusion.trim(),
      basis: '形态特征',
      referenceBook: '《中国大型真菌》',
      referencePage: '—',
      confidence: form.confidence,
      needReview: form.needReview,
      reviewer: '祁野',
      date: form.collectDate
    })
  }
  ElMessage.success(`已登记手记 ${note.tempCode}`)
}

/* ---------------- 批量造数（演示大批量排队） ---------------- */
const batchGen = reactive({
  count: 2500,
  pointId: '',
  startDate: '2026-07-01',
  failChunk: 0
})

function dateAdd(base: string, days: number): string {
  const d = new Date(base)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

async function generateBatch(): Promise<void> {
  if (!batchGen.pointId) {
    ElMessage.warning('请选择采集点')
    return
  }
  const n = Math.max(1, Math.floor(batchGen.count))
  const baseSeq = fieldState.notes.length
  const notes: FieldNote[] = []
  const spores: FieldSporePrint[] = []
  const colors = SPORE_COLORS
  for (let i = 0; i < n; i++) {
    const noteId = uid('fnt')
    const tempCode = `TMP-${String(baseSeq + i + 1).padStart(4, '0')}`
    notes.push({
      id: noteId,
      tempCode,
      tempName: `批量外业条目 ${baseSeq + i + 1}`,
      fruitBodyCount: 1 + (i % 5),
      pointId: batchGen.pointId,
      capDiameter: 3 + (i % 8),
      capShape: '平展',
      capMargin: '全缘',
      capTexture: '光滑',
      fleshThickness: 0.8,
      fleshReaction: '不变色',
      attachment: '离生',
      gillDensity: '中等',
      stipeLength: 4 + (i % 6),
      stipeDiameter: 0.8,
      ring: '无菌环',
      volva: '无菌托',
      odor: '',
      hostTree: '',
      // 日期在起始日附近散布，便于观察同点按日期排序换号
      collectDate: dateAdd(batchGen.startDate, i % 60),
      collector: '沈禾',
      note: '批量造数',
      status: 'pending',
      createdAt: today
    })
    if (i % 2 === 0) {
      spores.push({
        id: uid('fsp'),
        noteId,
        color: colors[i % colors.length],
        shape: '批量圆形印痕',
        hours: 8,
        observeDate: dateAdd(batchGen.startDate, i % 60),
        moisture: '新鲜样本'
      })
    }
  }
  const { db } = await import('@/hooks/usePersistentStore')
  await db.fieldNotes.bulkPut(notes)
  await db.fieldSpores.bulkPut(spores)
  await fieldStore.getState().hydrate()
  ElMessage.success(`已生成 ${n} 条待并入手记（含 ${spores.length} 份孢子印）`)
}

/* ---------------- 上交并入 ---------------- */
const submitName = ref('')
const failChunkInput = ref(0)

const selectedIds = computed(() =>
  pendingNotes.value.filter((note) => selected.value.includes(note.id))
)
const largeBatch = computed(() => selectedIds.value.length > LARGE_BATCH_THRESHOLD)

async function submitSelected(hold: boolean): Promise<void> {
  const notes = selectedIds.value
  if (notes.length === 0) {
    ElMessage.warning('请先勾选要上交的手记')
    return
  }
  try {
    const job = await mergeJobStore.getState().enqueue(notes, {
      name: submitName.value.trim() || `批次 ${pointCode(notes[0].pointId)} ${today}`,
      failChunk: failChunkInput.value || 0,
      hold
    })
    selected.value = []
    failChunkInput.value = 0
    ElMessage.success(
      hold
        ? `批次「${job.name}」已排队暂存（${notes.length} 条），可再交一批后统一开排`
        : `批次「${job.name}」已上交，${notes.length} 条进入换号流程`
    )
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  }
}

function startQueue(): void {
  mergeJobStore.getState().startQueue()
  ElMessage.success('队列开始处理：各批次按上交先后轮转发号')
}

async function retryJob(jobId: string): Promise<void> {
  try {
    await mergeJobStore.getState().retryJob(jobId)
    ElMessage.success('已按批次重试：仅重跑失败分片，已换号的条目与号段保留')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : String(err))
  }
}

async function removeJob(jobId: string): Promise<void> {
  await ElMessageBox.confirm('删除批次记录？未成功分片对应手记将回到待上交状态，已占用号段保留。', '删除确认', {
    type: 'warning'
  })
  await mergeJobStore.getState().removeJob(jobId)
  ElMessage.success('批次已删除')
}

async function removeNote(note: FieldNote): Promise<void> {
  if (note.jobId) {
    ElMessage.warning('该手记已在并入批次中，请先处理批次')
    return
  }
  await ElMessageBox.confirm(`确认删除手记 ${note.tempCode}？其孢子印与鉴定结论一并删除`, '删除确认', {
    type: 'warning'
  })
  await fieldStore.getState().removeNote(note.id)
}

/* ---------------- 批次展示 ---------------- */
const JOB_STATUS_LABEL: Record<string, { label: string; type: 'info' | 'warning' | 'primary' | 'success' | 'danger' }> = {
  held: { label: '排队待开', type: 'info' },
  queued: { label: '排队中', type: 'warning' },
  running: { label: '换号中', type: 'primary' },
  partial: { label: '部分失败', type: 'danger' },
  done: { label: '已完成', type: 'success' },
  failed: { label: '失败', type: 'danger' }
}

function progress(job: { chunks: { status: string }[] }): { done: number; total: number } {
  return { done: job.chunks.filter((c) => c.status === 'done').length, total: job.chunks.length }
}

function segmentText(seg: { pointCode: string; year: string; start: number; end: number }): string {
  return seg.start === seg.end
    ? `${seg.pointCode}-${seg.year}-${String(seg.start).padStart(3, '0')}`
    : `${seg.pointCode}-${seg.year}-${String(seg.start).padStart(3, '0')}~${String(seg.end).padStart(3, '0')}`
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">外业手记并入</h2>
        <p class="page-sub">
          外业手记只有临时编号，孢子印与鉴定结论挂在临时号上；上交时按「采集点 + 年份」重排正式编号
          （点编号-年份-序号，同点按日期排），两批一起交则按上交先后轮着用号段。超过
          {{ LARGE_BATCH_THRESHOLD }} 条先排队、分批换号；中途失败可按批次重试，号段不回收、不重号。
        </p>
      </div>
    </div>

    <el-row :gutter="12">
      <el-col :span="10">
        <el-card shadow="never" class="form-card">
          <template #header>登记手记（临时号）</template>
          <el-form label-width="92px">
            <el-form-item label="暂定名">
              <el-input v-model="form.tempName" placeholder="如 松林小灰伞（暂定）" />
            </el-form-item>
            <el-form-item label="采集点" required>
              <el-select v-model="form.pointId" style="width: 100%">
                <el-option
                  v-for="point in pointState.points"
                  :key="point.id"
                  :label="`${point.code} · ${point.name}`"
                  :value="point.id"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="采集日期">
              <el-date-picker v-model="form.collectDate" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
            <el-form-item label="采集人">
              <el-input v-model="form.collector" />
            </el-form-item>
            <el-form-item label="关联树种">
              <el-input v-model="form.hostTree" />
            </el-form-item>
            <el-divider content-position="left">挂接（都挂在临时号上）</el-divider>
            <el-form-item label="孢子印">
              <el-checkbox v-model="form.withSpore">同时登记孢子印</el-checkbox>
              <el-select v-if="form.withSpore" v-model="form.sporeColor" style="width: 140px; margin-left: 8px">
                <el-option v-for="c in SPORE_COLORS" :key="c" :label="c" :value="c" />
              </el-select>
            </el-form-item>
            <el-form-item label="鉴定结论">
              <el-input v-model="form.conclusion" placeholder="留空则不挂鉴定结论，如 Amanita sp." />
            </el-form-item>
            <el-form-item label="置信度/复核">
              <el-select v-model="form.confidence" style="width: 100px">
                <el-option v-for="c in ID_CONFIDENCES" :key="c" :label="c" :value="c" />
              </el-select>
              <el-checkbox v-model="form.needReview" style="margin-left: 12px">待复核</el-checkbox>
            </el-form-item>
            <el-button type="primary" @click="addNote">登记一条手记</el-button>
          </el-form>
        </el-card>
      </el-col>

      <el-col :span="14">
        <el-card shadow="never" class="form-card">
          <template #header>批量造数（演示大批量排队换号）</template>
          <el-form label-width="110px">
            <el-form-item label="采集点">
              <el-select v-model="batchGen.pointId" style="width: 100%">
                <el-option
                  v-for="point in pointState.points"
                  :key="point.id"
                  :label="`${point.code} · ${point.name}`"
                  :value="point.id"
                />
              </el-select>
            </el-form-item>
            <el-form-item :label="`条数（>${LARGE_BATCH_THRESHOLD} 为大批量）`">
              <el-input-number v-model="batchGen.count" :min="1" :max="20000" :controls="false" />
            </el-form-item>
            <el-form-item label="起始日期">
              <el-date-picker v-model="batchGen.startDate" type="date" value-format="YYYY-MM-DD" style="width: 180px" />
            </el-form-item>
            <el-button @click="generateBatch">生成批量手记（约一半带孢子印）</el-button>
          </el-form>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="note-card">
      <template #header>
        <div class="card-head">
          <span>待并入手记（{{ pendingNotes.length }}）</span>
          <div>
            <el-input
              v-model.number="failChunkInput"
              :min="0"
              type="number"
              placeholder="故障注入：失败分片序号(1起)"
              style="width: 220px; margin-right: 8px"
            />
            <el-input v-model="submitName" placeholder="批次名称（可选）" style="width: 200px; margin-right: 8px" />
            <el-button :disabled="selectedIds.length === 0" @click="submitSelected(true)">
              上交并入（挂起攒批）
            </el-button>
            <el-button type="primary" :disabled="selectedIds.length === 0" @click="submitSelected(false)">
              上交并入（直接开始）{{ largeBatch ? '· 大批量排队' : '' }}
            </el-button>
          </div>
        </div>
      </template>
      <el-table :data="pendingNotes" height="320" @selection-change="(rows: FieldNote[]) => (selected = rows.map((r) => r.id))">
        <el-table-column type="selection" width="42" />
        <el-table-column prop="tempCode" label="临时号" width="110" />
        <el-table-column label="采集点" width="200">
          <template #default="{ row }: { row: FieldNote }">{{ pointCode(row.pointId) }} · {{ pointName(row.pointId) }}</template>
        </el-table-column>
        <el-table-column prop="collectDate" label="采集日期" width="110" />
        <el-table-column prop="tempName" label="暂定名" />
        <el-table-column label="孢子印" width="90">
          <template #default="{ row }: { row: FieldNote }">
            <el-tag v-if="sporeOf(row.id)" size="small">{{ sporeOf(row.id)?.color }}</el-tag>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="鉴定结论" width="150">
          <template #default="{ row }: { row: FieldNote }">
            <span v-if="identifyOf(row.id)">{{ identifyOf(row.id)?.conclusion }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="80">
          <template #default="{ row }: { row: FieldNote }">
            <el-button size="small" type="danger" plain @click="removeNote(row)">删</el-button>
          </template>
        </el-table-column>
      </el-table>
      <p class="tip">
        已选 {{ selectedIds.length }} 条。两批演示：第一批点「挂起攒批」，再选第二批同样挂起，然后到下方批次区点「统一开始排队」，
        可看到同采集点同年份两批轮着占用号段（如 A 批 001~200、B 批 201~400、A 批 401~600 …）。
      </p>
    </el-card>

    <el-card shadow="never" class="note-card">
      <template #header>
        <div class="card-head">
          <span>并入批次队列（{{ jobState.jobs.length }}）</span>
          <el-button type="success" plain @click="startQueue">统一开始排队 / 唤醒队列</el-button>
        </div>
      </template>
      <el-empty v-if="jobState.jobs.length === 0" description="还没有上交批次" />
      <div v-for="job in jobState.jobs" :key="job.id" class="job">
        <div class="job-head">
          <div>
            <el-tag :type="JOB_STATUS_LABEL[job.status]?.type" size="small">
              {{ JOB_STATUS_LABEL[job.status]?.label ?? job.status }}
            </el-tag>
            <b class="job-name">{{ job.name }}</b>
            <span class="muted">
              #{{ job.queueOrder }} · {{ job.succeeded }}/{{ job.total }} 条 ·
              分片 {{ progress(job).done }}/{{ progress(job).total }} · 每片 {{ job.chunkSize }} 条
            </span>
          </div>
          <div>
            <el-button
              v-if="job.status === 'held'"
              size="small"
              type="success"
              @click="startQueue"
            >
              开始
            </el-button>
            <el-button
              v-if="job.status === 'partial' || job.status === 'failed'"
              size="small"
              type="primary"
              @click="retryJob(job.id)"
            >
              按批次重试
            </el-button>
            <el-button
              v-if="['done', 'partial', 'failed'].includes(job.status)"
              size="small"
              type="danger"
              plain
              @click="removeJob(job.id)"
            >
              删除批次
            </el-button>
          </div>
        </div>
        <el-progress
          v-if="job.chunks.length > 0"
          :percentage="Math.round((job.succeeded / Math.max(1, job.total)) * 100)"
          :status="job.status === 'done' ? 'success' : job.status === 'partial' ? 'exception' : undefined"
        />
        <p v-if="job.error" class="err">{{ job.error }}</p>
        <el-collapse v-if="job.chunks.length > 0" class="chunk-collapse">
          <el-collapse-item
            v-for="chunk in job.chunks"
            :key="chunk.index"
            :name="chunk.index"
            :title="`分片 ${chunk.index + 1}（${chunk.assignments.length} 条）`"
          >
            <template #title>
              <span class="chunk-title">
                <el-tag
                  size="small"
                  :type="chunk.status === 'done' ? 'success' : chunk.status === 'failed' ? 'danger' : 'info'"
                >
                  {{ chunk.status === 'done' ? '已换号' : chunk.status === 'failed' ? '失败' : '待处理' }}
                </el-tag>
                <span class="muted" style="margin-left: 8px">
                  号段：{{ chunk.segments.map(segmentText).join('，') || '—' }}
                </span>
              </span>
            </template>
            <div v-if="chunk.status === 'failed'" class="err">{{ chunk.error }}</div>
            <div class="assign-grid">
              <div v-for="a in chunk.assignments" :key="a.noteId" class="assign">
                <span class="mono muted">{{ a.tempCode }}</span>
                <span>→</span>
                <span class="mono" :class="{ done: chunk.status === 'done' }">{{ a.code }}</span>
              </div>
            </div>
          </el-collapse-item>
        </el-collapse>
      </div>
    </el-card>

    <el-card v-if="mergedNotes.length > 0" shadow="never" class="note-card">
      <template #header>最近换号结果（{{ mergedNotes.length }}）</template>
      <el-table :data="[...mergedNotes].slice(-8).reverse()" height="240">
        <el-table-column prop="tempCode" label="临时号" width="110" />
        <el-table-column prop="mergedCode" label="正式号" width="160" />
        <el-table-column label="采集点" width="200">
          <template #default="{ row }: { row: FieldNote }">{{ pointCode(row.pointId) }} · {{ pointName(row.pointId) }}</template>
        </el-table-column>
        <el-table-column prop="collectDate" label="采集日期" width="110" />
        <el-table-column prop="tempName" label="暂定名" />
        <el-table-column label="孢子印迁移" width="100">
          <template #default="{ row }: { row: FieldNote }">
            <el-tag v-if="sporeOf(row.id)" size="small" type="success">已随迁</el-tag>
            <span v-else class="muted">无</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<style scoped>
.form-card,
.note-card {
  border-radius: 12px;
  margin-bottom: 12px;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
}
.muted {
  color: #97a0a8;
  font-size: 12px;
}
.tip {
  margin: 8px 0 0;
  font-size: 12px;
  color: #7f8d82;
}
.err {
  color: #c0392b;
  font-size: 12px;
  margin: 4px 0;
}
.job {
  border: 1px solid #ece4d6;
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 10px;
}
.job-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.job-name {
  margin: 0 8px;
}
.chunk-collapse {
  margin-top: 6px;
  border-top: none;
}
.chunk-title {
  display: inline-flex;
  align-items: center;
}
.assign-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 4px 12px;
  padding: 4px 0;
}
.assign {
  display: flex;
  gap: 8px;
  font-size: 12px;
}
.assign .done {
  color: #1f8a70;
  font-weight: 600;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
</style>
