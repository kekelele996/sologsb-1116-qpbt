<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useStore } from '@/hooks/usePersistentStore'
import { renumberStore } from '@/stores/renumberStore'
import { pointStore } from '@/stores/pointStore'
import { LARGE_BATCH_THRESHOLD } from '@/utils/renumber'

const renumberState = useStore(renumberStore)
const pointState = useStore(pointStore)

const selected = ref<Set<string>>(new Set())
const twoBatches = ref(false)

const fieldNotes = computed(() => renumberState.fieldNotes)
const allSelected = computed(
  () => fieldNotes.value.length > 0 && selected.value.size === fieldNotes.value.length
)

function pointName(pointId: string): string {
  return pointState.points.find((p) => p.id === pointId)?.name ?? '未关联采集点'
}

function toggle(id: string): void {
  if (selected.value.has(id)) selected.value.delete(id)
  else selected.value.add(id)
}

function toggleAll(): void {
  if (allSelected.value) selected.value.clear()
  else selected.value = new Set(fieldNotes.value.map((r) => r.id))
}

/** 按采集人分批（两批一起交时轮着用号段） */
function splitTwoBatches(): [typeof fieldNotes.value, typeof fieldNotes.value] {
  const byCollector = new Map<string, typeof fieldNotes.value>()
  for (const rec of fieldNotes.value) {
    const key = rec.collector || '未填写采集人'
    if (!byCollector.has(key)) byCollector.set(key, [])
    byCollector.get(key)!.push(rec)
  }
  const groups = [...byCollector.values()]
  if (groups.length >= 2) {
    return [groups[0], groups.slice(1).flat()]
  }
  // 只有一个采集人：按日期先后对半分两批
  const sorted = [...fieldNotes.value].sort(
    (a, b) => a.collectDate.localeCompare(b.collectDate) || a.id.localeCompare(b.id)
  )
  const mid = Math.ceil(sorted.length / 2)
  return [sorted.slice(0, mid), sorted.slice(mid)]
}

async function startRenumber(): Promise<void> {
  const picked = fieldNotes.value.filter((r) => selected.value.has(r.id))
  if (picked.length === 0) {
    ElMessage.warning('请先勾选要并入图谱库的手记')
    return
  }
  if (picked.length >= LARGE_BATCH_THRESHOLD) {
    ElMessage.info(`大批量（${picked.length} 条）将分批排队换号`)
  }
  if (twoBatches.value) {
    const [b1, b2] = splitTwoBatches()
    // 只保留勾选的
    const ids = new Set(picked.map((r) => r.id))
    const batch1 = b1.filter((r) => ids.has(r.id))
    const batch2 = b2.filter((r) => ids.has(r.id))
    await renumberStore.getState().start([
      { batchIndex: 0, records: batch1 },
      { batchIndex: 1, records: batch2 }
    ])
  } else {
    await renumberStore.getState().start([{ batchIndex: 0, records: picked }])
  }
  selected.value.clear()
}

async function retry(): Promise<void> {
  await renumberStore.getState().retry()
}

async function resetJob(): Promise<void> {
  await renumberStore.getState().resetJob()
}

onMounted(async () => {
  await renumberStore.getState().hydrate()
  if (selected.value.size === 0 && fieldNotes.value.length > 0) {
    selected.value = new Set(fieldNotes.value.map((r) => r.id))
  }
})
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">并入图谱库 · 批量换号</h2>
        <p class="page-sub">
          外业手记只有临时编号，孢子印与鉴定结论都挂在条目上。并入图谱库时按采集点和年份重排正式编号，
          同一采集点内按日期排；两批一起交按上交先后轮着用号段，孢子印、鉴定结论与采集点统计跟着迁到新号。
        </p>
      </div>
    </div>

    <el-row :gutter="16" class="stat-row">
      <el-col :span="8">
        <el-card shadow="never" class="stat-card">
          <div class="stat-num">{{ fieldNotes.length }}</div>
          <div class="stat-label">外业手记（临时编号）</div>
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never" class="stat-card">
          <div class="stat-num">{{ renumberState.formalCount }}</div>
          <div class="stat-label">已入图谱库（正式编号）</div>
        </el-card>
      </el-col>
      <el-col :span="8">
        <el-card shadow="never" class="stat-card">
          <div class="stat-num">{{ selected.size }}</div>
          <div class="stat-label">本次勾选并入</div>
        </el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="block">
      <template #header>
        <div class="block-head">
          <span>外业手记清单</span>
          <div class="head-actions">
            <el-checkbox :model-value="allSelected" @change="toggleAll">全选</el-checkbox>
            <el-checkbox v-model="twoBatches">两批一起交（轮着用号段）</el-checkbox>
            <el-button
              type="primary"
              :disabled="selected.size === 0 || renumberState.running"
              @click="startRenumber"
            >
              并入图谱库
            </el-button>
          </div>
        </div>
      </template>

      <el-table :data="fieldNotes" border stripe max-height="420">
        <el-table-column width="48">
          <template #default="{ row }: { row: { id: string } }">
            <el-checkbox :model-value="selected.has(row.id)" @change="toggle(row.id)" />
          </template>
        </el-table-column>
        <el-table-column prop="code" label="临时编号" width="140">
          <template #default="{ row }: { row: { code: string } }">
            <span class="mono">{{ row.code }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="tempName" label="暂定名" min-width="160" />
        <el-table-column label="采集点" min-width="160">
          <template #default="{ row }: { row: { pointId: string } }">
            {{ pointName(row.pointId) }}
          </template>
        </el-table-column>
        <el-table-column prop="collectDate" label="采集日期" width="120" />
        <el-table-column prop="collector" label="采集人" width="100" />
      </el-table>
      <el-empty v-if="fieldNotes.length === 0" description="没有待换号的外业手记" />
    </el-card>

    <el-card v-if="renumberState.job.status !== 'idle'" shadow="never" class="block">
      <template #header>
        <div class="block-head">
          <span>换号进度</span>
          <el-tag
            :type="
              renumberState.job.status === 'done'
                ? 'success'
                : renumberState.job.status === 'error'
                  ? 'danger'
                  : 'primary'
            "
            effect="plain"
          >
            {{
              renumberState.job.status === 'done'
                ? '已完成'
                : renumberState.job.status === 'error'
                  ? '失败待重试'
                  : '进行中'
            }}
          </el-tag>
        </div>
      </template>
      <el-progress :percentage="renumberState.progress" :stroke-width="10" />
      <p class="muted">
        已换 {{ renumberState.job.done }} / {{ renumberState.job.total }} 条
        <template v-if="renumberState.job.failedChunk !== null">
          · 第 {{ renumberState.job.failedChunk + 1 }} 批失败
        </template>
      </p>
      <div class="log-box">
        <p v-for="(line, idx) in renumberState.logs" :key="idx" class="log-line">{{ line }}</p>
      </div>
      <div class="form-actions">
        <el-button
          v-if="renumberState.job.status === 'error'"
          type="primary"
          :loading="renumberState.running"
          @click="retry"
        >
          按批次重试
        </el-button>
        <el-button @click="resetJob">清空进度记录</el-button>
      </div>
    </el-card>
  </div>
</template>

<style scoped>
.stat-row {
  margin-bottom: 16px;
}
.stat-card {
  border-radius: 12px;
  text-align: center;
}
.stat-num {
  font-size: 28px;
  font-weight: 700;
  color: #c96f3a;
}
.stat-label {
  font-size: 12px;
  color: #7f8d82;
  margin-top: 4px;
}
.block {
  border-radius: 12px;
  margin-bottom: 16px;
}
.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.log-box {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: #f7f5f0;
  max-height: 200px;
  overflow: auto;
}
.log-line {
  margin: 2px 0;
  font-size: 12px;
  color: #4b5b50;
  font-family: ui-monospace, monospace;
}
.form-actions {
  margin-top: 12px;
  display: flex;
  gap: 8px;
}
</style>
