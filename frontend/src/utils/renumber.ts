import type { CollectPoint, FungusRecord } from '@/types'
import type { FungiGuideDb } from '@/hooks/usePersistentStore'

/** 正式编号正则：前缀-年份-序号，如 BHS-2026-001 */
export const FORMAL_CODE_RE = /^([A-Z][A-Z0-9]{1,9})-(\d{4})-(\d{3,})$/

/** 外业手记临时编号正则：REC-001 等 */
export const TEMP_CODE_RE = /^REC-\d+$/i

/** 大批量阈值：一次交几千条算大批量，分批换号 */
export const LARGE_BATCH_THRESHOLD = 1000

/** 每个事务处理的条目数（排队分批的块大小） */
export const CHUNK_SIZE = 200

export function isFormalCode(code: string): boolean {
  return FORMAL_CODE_RE.test(code)
}

export function isFieldNote(record: FungusRecord): boolean {
  return !isFormalCode(record.code)
}

export function parseFormalCode(code: string): { prefix: string; year: number; seq: number } | null {
  const m = FORMAL_CODE_RE.exec(code)
  if (!m) return null
  return { prefix: m[1], year: Number(m[2]), seq: Number(m[3]) }
}

/** 采集点编号前缀：优先用点的 code，否则从 id 推导（pt_bhs → BHS；uid 点取时间戳段保证唯一） */
export function pointPrefix(point: CollectPoint): string {
  const raw = (point.code ?? '').trim()
  if (raw) {
    const slug = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10)
    if (slug) return slug
  }
  const slug = point.id
    .replace(/^pt_/i, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 10)
  return slug || 'PT'
}

export function recordYear(record: FungusRecord): number {
  const y = Number(record.collectDate.slice(0, 4))
  return Number.isFinite(y) && y > 2000 ? y : new Date().getFullYear()
}

export interface RenumberPlanItem {
  record: FungusRecord
  oldId: string
  /** 新号（= 正式编号，同时作为条目新 id） */
  newId: string
  oldCode: string
  newCode: string
  pointId: string
  year: number
  seq: number
  batchIndex: number
}

export interface RenumberBatchInput {
  /** 上交先后顺序，从 0 开始 */
  batchIndex: number
  records: FungusRecord[]
}

/**
 * 生成换号方案。
 *
 * 规则：
 * - 按「采集点 + 年份」分组，同组内按采集日期排序；
 * - 两批一起交时按上交先后轮着用号段（b1[0], b2[0], b1[1], b2[1], …），避免撞号；
 * - 新号接在库里已有正式编号的最大序号之后，重交不重复编号。
 */
export function buildRenumberPlan(
  batches: RenumberBatchInput[],
  points: CollectPoint[],
  existingRecords: FungusRecord[]
): RenumberPlanItem[] {
  const pointById = new Map(points.map((p) => [p.id, p]))
  const batchCount = Math.max(batches.length, 1)

  // 已有正式编号的最大序号（按 采集点+年份），新号往后排
  const maxSeq = new Map<string, number>()
  for (const rec of existingRecords) {
    const parsed = parseFormalCode(rec.code)
    if (!parsed) continue
    const key = `${rec.pointId}|${parsed.year}`
    maxSeq.set(key, Math.max(maxSeq.get(key) ?? 0, parsed.seq))
  }

  // 按 (point, year) 分组
  const groups = new Map<string, { pointId: string; year: number; records: FungusRecord[] }>()
  for (const batch of batches) {
    for (const rec of batch.records) {
      const year = recordYear(rec)
      const key = `${rec.pointId}|${year}`
      if (!groups.has(key)) groups.set(key, { pointId: rec.pointId, year, records: [] })
      groups.get(key)!.records.push(rec)
    }
  }

  const plan: RenumberPlanItem[] = []

  for (const { pointId, year, records } of groups.values()) {
    const point = pointById.get(pointId)
    const prefix = point ? pointPrefix(point) : 'PT'
    const key = `${pointId}|${year}`
    let nextSeq = (maxSeq.get(key) ?? 0) + 1

    if (batchCount <= 1) {
      // 单批：同一采集点内按日期排
      const sorted = [...records].sort(
        (a, b) => a.collectDate.localeCompare(b.collectDate) || a.id.localeCompare(b.id)
      )
      for (const rec of sorted) {
        const seq = nextSeq++
        const newCode = `${prefix}-${year}-${String(seq).padStart(3, '0')}`
        plan.push({
          record: rec,
          oldId: rec.id,
          newId: newCode,
          oldCode: rec.code,
          newCode,
          pointId,
          year,
          seq,
          batchIndex: 0
        })
      }
    } else {
      // 多批：按上交先后轮着用号段
      const byBatch: FungusRecord[][] = Array.from({ length: batchCount }, () => [])
      for (const rec of records) {
        const bi = batches.findIndex((b) => b.records.some((r) => r.id === rec.id))
        if (bi >= 0) byBatch[bi].push(rec)
      }
      for (const batch of byBatch) {
        batch.sort((a, b) => a.collectDate.localeCompare(b.collectDate) || a.id.localeCompare(b.id))
      }
      const maxLen = Math.max(...byBatch.map((b) => b.length), 0)
      for (let i = 0; i < maxLen; i++) {
        for (let bi = 0; bi < batchCount; bi++) {
          const rec = byBatch[bi][i]
          if (!rec) continue
          const seq = nextSeq++
          const newCode = `${prefix}-${year}-${String(seq).padStart(3, '0')}`
          plan.push({
            record: rec,
            oldId: rec.id,
            newId: newCode,
            oldCode: rec.code,
            newCode,
            pointId,
            year,
            seq,
            batchIndex: bi
          })
        }
      }
    }
  }

  return plan
}

/** 把方案切成每批 CHUNK_SIZE 条的小块（排队分批换号） */
export function chunkPlan(plan: RenumberPlanItem[], size = CHUNK_SIZE): RenumberPlanItem[][] {
  const chunks: RenumberPlanItem[][] = []
  for (let i = 0; i < plan.length; i += size) {
    chunks.push(plan.slice(i, i + size))
  }
  return chunks
}

/**
 * 执行一个换号块（Dexie 事务，失败整块回滚，可按块重试）。
 *
 * - 条目 id 改为正式编号，code 同步为正式编号；
 * - 孢子印、鉴定结论的 recordId 跟着迁到新号，不指着旧号；
 * - 采集点统计按 pointId 实时计算，不受换号影响。
 */
export async function executeChunk(chunk: RenumberPlanItem[], db: FungiGuideDb): Promise<void> {
  // 块内新号去重校验，避免主键冲突
  const seen = new Set<string>()
  for (const item of chunk) {
    if (seen.has(item.newId)) {
      throw new Error(`换号方案出现重复新号：${item.newId}`)
    }
    seen.add(item.newId)
  }

  await db.transaction('rw', db.records, db.spores, db.identifies, async (tx) => {
    for (const item of chunk) {
      const { oldId, newId, record } = item
      if (oldId === newId) continue // 已是正式号，跳过（幂等）
      // 新号写入（id = 正式编号）
      const updated: FungusRecord = { ...record, id: newId, code: newId }
      await tx.records.put(updated)
      // 删旧号
      await tx.records.delete(oldId)
      // 孢子印 recordId 迁到新号
      await tx.spores.where('recordId').equals(oldId).modify({ recordId: newId })
      // 鉴定结论 recordId 迁到新号
      await tx.identifies.where('recordId').equals(oldId).modify({ recordId: newId })
    }
  })
}

/** 校验换号后引用完整性：孢子印、鉴定结论没有指着旧号（recordId 都能找到条目） */
export async function verifyIntegrity(db: FungiGuideDb): Promise<{ orphans: string[] }> {
  const records = await db.records.toArray()
  const recordIds = new Set(records.map((r) => r.id))
  const orphans: string[] = []
  const spores = await db.spores.toArray()
  for (const s of spores) {
    if (!recordIds.has(s.recordId)) orphans.push(`孢子印 ${s.id} → 条目 ${s.recordId}`)
  }
  const identifies = await db.identifies.toArray()
  for (const i of identifies) {
    if (!recordIds.has(i.recordId)) orphans.push(`鉴定结论 ${i.id} → 条目 ${i.recordId}`)
  }
  return { orphans }
}
