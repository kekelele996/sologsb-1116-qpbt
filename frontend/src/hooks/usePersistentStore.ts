import { onUnmounted, reactive } from 'vue'
import type { StoreApi } from 'zustand/vanilla'
import Dexie, { type Table } from 'dexie'
import type {
  CollectPoint,
  FieldIdentifyLog,
  FieldNote,
  FieldSporePrint,
  FungusRecord,
  IdentifyLog,
  MergeJob,
  SporePrint
} from '@/types'
import { parseFormalCode } from '@/utils/renumber'

/** IndexedDB 数据结构版本号 */
export const SCHEMA_VERSION = 3

export interface MetaRow {
  key: string
  value: number
}

/** Dexie 封装：条目 / 孢子印 / 采集点 / 鉴定结论 四张表 + 外业手记三表 + 并入任务 + 元数据 */
class FungiGuideDb extends Dexie {
  records!: Table<FungusRecord, string>
  spores!: Table<SporePrint, string>
  points!: Table<CollectPoint, string>
  identifies!: Table<IdentifyLog, string>
  fieldNotes!: Table<FieldNote, string>
  fieldSpores!: Table<FieldSporePrint, string>
  fieldIdentifies!: Table<FieldIdentifyLog, string>
  mergeJobs!: Table<MergeJob, string>
  meta!: Table<MetaRow, string>

  constructor() {
    super('gbfungiguide')
    this.version(1).stores({
      records: 'id, code, pointId, attachment',
      spores: 'id, recordId, color',
      points: 'id, name, substrate',
      identifies: 'id, recordId, conclusion',
      meta: 'key'
    })
    // v2：新增「菌肉变色反应」字段，迁移时为历史条目补齐默认值（不变色）
    this.version(2)
      .stores({
        records: 'id, code, pointId, attachment, capShape',
        spores: 'id, recordId, color, observeDate',
        points: 'id, name, substrate, vegetation',
        identifies: 'id, recordId, conclusion, date',
        meta: 'key'
      })
      .upgrade(async (tx) => {
        await tx
          .table<FungusRecord, string>('records')
          .toCollection()
          .modify((record) => {
            if (!record.fleshReaction) {
              record.fleshReaction = '不变色'
            }
          })
      })
    // v3：外业手记（临时号）及其孢子印/鉴定结论 + 并入任务；采集点增加正式编号前缀 code
    this.version(SCHEMA_VERSION)
      .stores({
        records: 'id, code, pointId, attachment, capShape',
        spores: 'id, recordId, color, observeDate',
        points: 'id, code, name, substrate, vegetation',
        identifies: 'id, recordId, conclusion, date',
        fieldNotes: 'id, tempCode, pointId, status, collectDate, jobId',
        fieldSpores: 'id, noteId',
        fieldIdentifies: 'id, noteId',
        mergeJobs: 'id, status, queueOrder',
        meta: 'key'
      })
      .upgrade(async (tx) => {
        // 为历史采集点补齐编号前缀：优先从其条目正式号 BHS-2026-001 反解，否则回退 PT+序号
        const pointsTable = tx.table<CollectPoint, string>('points')
        const recordsTable = tx.table<FungusRecord, string>('records')
        const records = await recordsTable.toArray()
        const prefixByPoint = new Map<string, string>()
        const used = new Set<string>()
        for (const record of records) {
          const parsed = parseFormalCode(record.code)
          if (parsed) {
            prefixByPoint.set(record.pointId, parsed.pointCode)
            used.add(parsed.pointCode)
          }
        }
        const points = await pointsTable.toArray()
        let fallbackSeq = 1
        points.forEach((point) => {
          let code = prefixByPoint.get(point.id)
          if (!code) {
            do {
              code = `PT${fallbackSeq++}`
            } while (used.has(code))
          }
          used.add(code)
          point.code = code
        })
        await pointsTable.bulkPut(points)
      })
  }
}

export const db = new FungiGuideDb()

/** 写入当前数据结构版本号 */
export async function stampDbVersion(): Promise<void> {
  await db.meta.put({ key: 'schemaVersion', value: SCHEMA_VERSION })
}

/** 读取整表 */
export async function syncAll<T extends object>(table: Table<T, string>): Promise<T[]> {
  return table.toArray()
}

/** 写入一条记录 */
export async function syncPut<T extends object>(table: Table<T, string>, row: T): Promise<void> {
  await table.put(row)
}

/** 删除一条记录 */
export async function syncDelete<T extends object>(table: Table<T, string>, id: string): Promise<void> {
  await table.delete(id)
}

/** 把 Zustand vanilla store 桥接到 Vue 响应式状态 */
export function useStore<T extends object>(store: StoreApi<T>): T {
  const state = reactive({ ...store.getState() }) as T
  const unsubscribe = store.subscribe((next: T) => {
    Object.assign(state, next)
  })
  onUnmounted(() => unsubscribe())
  return state
}

/** 首次打开写入示例数据，保证各页面进入即有事可做 */
export async function seedDemoData(): Promise<void> {
  const count = await db.points.count()
  if (count > 0) return

  const today = new Date().toISOString().slice(0, 10)

  await db.points.bulkPut([
    {
      id: 'pt_bhs',
      code: 'BHS',
      name: '百花山栎树林样线',
      longitude: 115.6218,
      latitude: 39.8152,
      altitude: 1420,
      vegetation: '针阔混交林',
      substrate: '落叶层',
      companionTrees: '辽东栎、油松',
      collectDate: today,
      collector: '沈禾'
    },
    {
      id: 'pt_yls',
      code: 'YLS',
      name: '云龙山腐木沟',
      longitude: 117.2841,
      latitude: 34.2615,
      altitude: 260,
      vegetation: '常绿阔叶林',
      substrate: '腐木',
      companionTrees: '麻栎、枫香',
      collectDate: today,
      collector: '沈禾'
    }
  ])

  await db.records.bulkPut([
    {
      id: 'rec_001',
      code: 'BHS-2026-001',
      tempName: '橙黄牛肝菌（暂定）',
      fruitBodyCount: 3,
      pointId: 'pt_bhs',
      capDiameter: 9.5,
      capShape: '半球形',
      capMargin: '全缘',
      capTexture: '绒状',
      fleshThickness: 2.1,
      fleshReaction: '缓慢变蓝',
      attachment: '直生',
      gillDensity: '中等',
      stipeLength: 7.4,
      stipeDiameter: 2.2,
      ring: '膜质菌环',
      volva: '无菌托',
      odor: '淡淡坚果味',
      hostTree: '辽东栎',
      collectDate: today,
      collector: '沈禾',
      note: '菌管层易剥离，仅作形态记录'
    },
    {
      id: 'rec_002',
      code: 'BHS-2026-002',
      tempName: '灰紫小伞（暂定）',
      fruitBodyCount: 6,
      pointId: 'pt_bhs',
      capDiameter: 4.2,
      capShape: '平展',
      capMargin: '波状',
      capTexture: '光滑',
      fleshThickness: 0.6,
      fleshReaction: '不变色',
      attachment: '离生',
      gillDensity: '密集',
      stipeLength: 6.8,
      stipeDiameter: 0.8,
      ring: '无菌环',
      volva: '无菌托',
      odor: '无明显气味',
      hostTree: '油松',
      collectDate: today,
      collector: '沈禾',
      note: '菌褶边缘略带紫晕'
    },
    {
      id: 'rec_003',
      code: 'YLS-2026-001',
      tempName: '褐褶韧革菌（暂定）',
      fruitBodyCount: 2,
      pointId: 'pt_yls',
      capDiameter: 12.6,
      capShape: '漏斗形',
      capMargin: '内卷',
      capTexture: '鳞片状',
      fleshThickness: 1.4,
      fleshReaction: '变褐',
      attachment: '延生',
      gillDensity: '稀疏',
      stipeLength: 3.2,
      stipeDiameter: 3.6,
      ring: '无菌环',
      volva: '无菌托',
      odor: '土腥味',
      hostTree: '麻栎',
      collectDate: today,
      collector: '祁野',
      note: '生于倒木侧面，质地木栓化'
    }
  ])

  await db.spores.bulkPut([
    {
      id: 'spo_001',
      recordId: 'rec_001',
      color: '淡黄',
      shape: '圆形印痕，边缘略散',
      hours: 12,
      observeDate: today,
      moisture: '子实体偏干，印痕较薄'
    },
    {
      id: 'spo_002',
      recordId: 'rec_002',
      color: '白色',
      shape: '圆形印痕，中心致密',
      hours: 8,
      observeDate: today,
      moisture: '新鲜子实体，印痕厚实'
    },
    {
      id: 'spo_003',
      recordId: 'rec_003',
      color: '粉褐',
      shape: '不规则印痕',
      hours: 24,
      observeDate: today,
      moisture: '木质化样本，印痕浅'
    }
  ])

  await db.identifies.bulkPut([
    {
      id: 'idf_001',
      recordId: 'rec_001',
      conclusion: 'Boletus sp.',
      basis: '形态特征',
      referenceBook: '《中国大型真菌》',
      referencePage: 'P.312',
      confidence: '低',
      needReview: true,
      reviewer: '祁野',
      date: today
    },
    {
      id: 'idf_002',
      recordId: 'rec_002',
      conclusion: 'Lepista sordida',
      basis: '孢子印',
      referenceBook: '《菌物图鉴》',
      referencePage: 'P.145',
      confidence: '中',
      needReview: false,
      reviewer: '祁野',
      date: today
    }
  ])

  // 外业手记：条目只有临时编号，孢子印与鉴定结论都挂在临时号上，等待并入换号
  await db.fieldNotes.bulkPut([
    {
      id: 'fnt_001',
      tempCode: 'TMP-0001',
      tempName: '松林小灰伞（暂定）',
      fruitBodyCount: 4,
      pointId: 'pt_bhs',
      capDiameter: 3.6,
      capShape: '钟形',
      capMargin: '全缘',
      capTexture: '光滑',
      fleshThickness: 0.5,
      fleshReaction: '不变色',
      attachment: '离生',
      gillDensity: '密集',
      stipeLength: 6.1,
      stipeDiameter: 0.7,
      ring: '易脱落',
      volva: '无菌托',
      odor: '无明显气味',
      hostTree: '油松',
      collectDate: '2026-08-12',
      collector: '沈禾',
      note: '外业临时记录，待换正式号',
      status: 'pending',
      createdAt: today
    },
    {
      id: 'fnt_002',
      tempCode: 'TMP-0002',
      tempName: '栎树根牛肝菌（暂定）',
      fruitBodyCount: 2,
      pointId: 'pt_bhs',
      capDiameter: 8.2,
      capShape: '半球形',
      capMargin: '全缘',
      capTexture: '粘滑',
      fleshThickness: 1.9,
      fleshReaction: '迅速变蓝',
      attachment: '直生',
      gillDensity: '中等',
      stipeLength: 7.0,
      stipeDiameter: 2.0,
      ring: '无菌环',
      volva: '无菌托',
      odor: '菌香',
      hostTree: '辽东栎',
      collectDate: '2026-08-05',
      collector: '沈禾',
      note: '伤变蓝明显',
      status: 'pending',
      createdAt: today
    },
    {
      id: 'fnt_003',
      tempCode: 'TMP-0003',
      tempName: '腐木白韧革（暂定）',
      fruitBodyCount: 5,
      pointId: 'pt_yls',
      capDiameter: 6.4,
      capShape: '平展',
      capMargin: '附着菌幕残片',
      capTexture: '绒状',
      fleshThickness: 0.8,
      fleshReaction: '不变色',
      attachment: '延生',
      gillDensity: '稀疏',
      stipeLength: 2.1,
      stipeDiameter: 2.8,
      ring: '无菌环',
      volva: '无菌托',
      odor: '淡土腥',
      hostTree: '枫香',
      collectDate: '2026-09-01',
      collector: '祁野',
      note: '覆瓦状群生',
      status: 'pending',
      createdAt: today
    }
  ])

  await db.fieldSpores.bulkPut([
    {
      id: 'fsp_001',
      noteId: 'fnt_001',
      color: '奶油色',
      shape: '圆形薄印',
      hours: 6,
      observeDate: '2026-08-12',
      moisture: '新鲜样本'
    },
    {
      id: 'fsp_002',
      noteId: 'fnt_002',
      color: '淡黄',
      shape: '印层较厚',
      hours: 10,
      observeDate: '2026-08-06',
      moisture: '湿度大'
    }
  ])

  await db.fieldIdentifies.bulkPut([
    {
      id: 'fid_001',
      noteId: 'fnt_002',
      conclusion: 'Boletus separans?',
      basis: '形态特征',
      referenceBook: '《中国大型真菌》',
      referencePage: 'P.318',
      confidence: '低',
      needReview: true,
      reviewer: '祁野',
      date: '2026-08-10'
    }
  ])
}
