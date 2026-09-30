import type { FungusRecord, SporePrint, IdentifyLog } from '@/types'
import { executeChunk, verifyIntegrity, type RenumberPlanItem } from '@/utils/renumber'

let passed = 0
let failed = 0
function assert(cond: boolean, msg: string): void {
  if (cond) passed++
  else { failed++; console.error(`FAIL: ${msg}`) }
}

// --- 内存 mock 数据库，模拟 Dexie 的 transaction/put/delete/where/modify/toArray ---
class MockTable<T extends { id: string }> {
  rows = new Map<string, T>()
  async put(row: T): Promise<void> { this.rows.set(row.id, row) }
  async delete(id: string): Promise<void> { this.rows.delete(id) }
  async toArray(): Promise<T[]> { return [...this.rows.values()] }
  where(field: string) {
    return {
      equals: (val: string) => ({
        modify: async (changes: Partial<T>) => {
          for (const row of this.rows.values()) {
            if ((row as Record<string, unknown>)[field] === val) Object.assign(row, changes)
          }
        }
      })
    }
  }
}

class MockDb {
  records = new MockTable<FungusRecord>()
  spores = new MockTable<SporePrint>()
  identifies = new MockTable<IdentifyLog>()

  async transaction(mode: string, ...args: unknown[]): Promise<void> {
    const cb = args[args.length - 1] as (tx: MockDb) => Promise<void>
    // 简单事务：直接执行（mock 不回滚）
    await cb(this)
  }
}

function makeRecord(id: string, code: string, pointId = 'pt_bhs'): FungusRecord {
  return {
    id, code, tempName: '', fruitBodyCount: 1, pointId,
    capDiameter: 5, capShape: '平展', capMargin: '全缘', capTexture: '光滑',
    fleshThickness: 1, fleshReaction: '不变色', attachment: '直生', gillDensity: '中等',
    stipeLength: 5, stipeDiameter: 1, ring: '无菌环', volva: '无菌托',
    odor: '', hostTree: '', collectDate: '2026-01-01', collector: '', note: ''
  }
}

async function main(): Promise<void> {
  const db = new MockDb()

  // 手记：临时编号 + 临时 id
  const rec1 = makeRecord('rec_aaa', 'REC-001')
  const rec2 = makeRecord('rec_bbb', 'REC-002')
  await db.records.put(rec1)
  await db.records.put(rec2)

  // 孢子印和鉴定结论挂在临时 id 上
  await db.spores.put({ id: 'spo_1', recordId: 'rec_aaa', color: '淡黄', shape: '', hours: 12, observeDate: '2026-01-01', moisture: '' })
  await db.spores.put({ id: 'spo_2', recordId: 'rec_bbb', color: '白色', shape: '', hours: 8, observeDate: '2026-01-01', moisture: '' })
  await db.identifies.put({ id: 'idf_1', recordId: 'rec_aaa', conclusion: 'Boletus sp.', basis: '形态特征', referenceBook: '', referencePage: '', confidence: '低', needReview: true, reviewer: '', date: '2026-01-01' })

  // 换号方案
  const chunk: RenumberPlanItem[] = [
    { record: rec1, oldId: 'rec_aaa', newId: 'BHS-2026-001', oldCode: 'REC-001', newCode: 'BHS-2026-001', pointId: 'pt_bhs', year: 2026, seq: 1, batchIndex: 0 },
    { record: rec2, oldId: 'rec_bbb', newId: 'BHS-2026-002', oldCode: 'REC-002', newCode: 'BHS-2026-002', pointId: 'pt_bhs', year: 2026, seq: 2, batchIndex: 0 }
  ]

  await executeChunk(chunk, db as unknown as Parameters<typeof executeChunk>[1])

  // 条目：旧号删除，新号写入
  const afterRecs = await db.records.toArray()
  assert(afterRecs.length === 2, '换号后仍为 2 条')
  assert(!afterRecs.some((r) => r.id === 'rec_aaa'), '旧 id rec_aaa 已删除')
  assert(!afterRecs.some((r) => r.id === 'rec_bbb'), '旧 id rec_bbb 已删除')
  assert(afterRecs.some((r) => r.id === 'BHS-2026-001' && r.code === 'BHS-2026-001'), '新 id BHS-2026-001 写入')
  assert(afterRecs.some((r) => r.id === 'BHS-2026-002' && r.code === 'BHS-2026-002'), '新 id BHS-2026-002 写入')

  // 孢子印：recordId 迁到新号
  const afterSpores = await db.spores.toArray()
  const spo1 = afterSpores.find((s) => s.id === 'spo_1')
  const spo2 = afterSpores.find((s) => s.id === 'spo_2')
  assert(spo1?.recordId === 'BHS-2026-001', '孢子印 spo_1 的 recordId 迁到 BHS-2026-001')
  assert(spo2?.recordId === 'BHS-2026-002', '孢子印 spo_2 的 recordId 迁到 BHS-2026-002')

  // 鉴定结论：recordId 迁到新号
  const afterIdfs = await db.identifies.toArray()
  const idf1 = afterIdfs.find((i) => i.id === 'idf_1')
  assert(idf1?.recordId === 'BHS-2026-001', '鉴定结论 idf_1 的 recordId 迁到 BHS-2026-001')

  // 完整性校验：无孤立引用
  const { orphans } = await verifyIntegrity(db as unknown as Parameters<typeof verifyIntegrity>[0])
  assert(orphans.length === 0, '换号后无孤立引用')

  // 构造一个孤立引用，校验能检测到
  await db.spores.put({ id: 'spo_orphan', recordId: 'rec_gone', color: '白色', shape: '', hours: 1, observeDate: '2026-01-01', moisture: '' })
  const { orphans: orphans2 } = await verifyIntegrity(db as unknown as Parameters<typeof verifyIntegrity>[0])
  assert(orphans2.length === 1 && orphans2[0].includes('spo_orphan'), '能检测到孤立孢子印引用')

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main()
