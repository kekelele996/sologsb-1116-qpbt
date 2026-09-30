import type { CollectPoint, FungusRecord } from '@/types'
import {
  buildRenumberPlan,
  chunkPlan,
  isFieldNote,
  isFormalCode,
  parseFormalCode,
  pointPrefix,
  recordYear,
  FORMAL_CODE_RE
} from '@/utils/renumber'

let passed = 0
let failed = 0

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++
  } else {
    failed++
    console.error(`FAIL: ${msg}`)
  }
}

function makeRecord(over: Partial<FungusRecord> & { id: string; code: string; pointId: string; collectDate: string }): FungusRecord {
  return {
    tempName: '',
    fruitBodyCount: 1,
    capDiameter: 5,
    capShape: '平展',
    capMargin: '全缘',
    capTexture: '光滑',
    fleshThickness: 1,
    fleshReaction: '不变色',
    attachment: '直生',
    gillDensity: '中等',
    stipeLength: 5,
    stipeDiameter: 1,
    ring: '无菌环',
    volva: '无菌托',
    odor: '',
    hostTree: '',
    collector: '',
    note: '',
    ...over
  } as FungusRecord
}

function makePoint(over: Partial<CollectPoint> & { id: string; name: string }): CollectPoint {
  return {
    code: '',
    longitude: 116.4,
    latitude: 39.9,
    altitude: 800,
    vegetation: '针阔混交林',
    substrate: '落叶层',
    companionTrees: '',
    collectDate: '2026-01-01',
    collector: '',
    ...over
  } as CollectPoint
}

// --- 测试 1: 正式编号正则 ---
assert(isFormalCode('BHS-2026-001'), 'BHS-2026-001 是正式编号')
assert(isFormalCode('YLS-2025-123'), 'YLS-2025-123 是正式编号')
assert(!isFormalCode('REC-001'), 'REC-001 不是正式编号')
assert(!isFormalCode('rec-001'), 'rec-001 不是正式编号')
assert(isFieldNote(makeRecord({ id: 'rec_a', code: 'REC-001', pointId: 'p1', collectDate: '2026-01-01' })), 'REC-001 是手记')
assert(!isFieldNote(makeRecord({ id: 'BHS-2026-001', code: 'BHS-2026-001', pointId: 'p1', collectDate: '2026-01-01' })), 'BHS-2026-001 不是手记')

// --- 测试 2: 解析正式编号 ---
const parsed = parseFormalCode('BHS-2026-001')
assert(parsed !== null && parsed.prefix === 'BHS' && parsed.year === 2026 && parsed.seq === 1, '解析 BHS-2026-001')

// --- 测试 3: 采集点前缀 ---
assert(pointPrefix(makePoint({ id: 'pt_bhs', name: '百花山', code: 'BHS' })) === 'BHS', '点 code=BHS → BHS')
assert(pointPrefix(makePoint({ id: 'pt_yls', name: '云龙山' })) === 'YLS', 'pt_yls → YLS')
assert(pointPrefix(makePoint({ id: 'pt_lx2k3f_ab12cd', name: '某点' })) === 'LX2K3FAB12', '无 code 的 uid 点 → 取时间戳段保证唯一')

// --- 测试 4: 单批换号，按采集点+年份分组，同组按日期排 ---
const points = [
  makePoint({ id: 'pt_bhs', name: '百花山', code: 'BHS' }),
  makePoint({ id: 'pt_yls', name: '云龙山', code: 'YLS' })
]
const fieldNotes = [
  makeRecord({ id: 'rec_3', code: 'REC-003', pointId: 'pt_bhs', collectDate: '2026-03-01' }),
  makeRecord({ id: 'rec_1', code: 'REC-001', pointId: 'pt_bhs', collectDate: '2026-01-01' }),
  makeRecord({ id: 'rec_2', code: 'REC-002', pointId: 'pt_bhs', collectDate: '2026-02-01' }),
  makeRecord({ id: 'rec_4', code: 'REC-004', pointId: 'pt_yls', collectDate: '2026-01-15' }),
  makeRecord({ id: 'rec_5', code: 'REC-005', pointId: 'pt_bhs', collectDate: '2025-06-01' })
]
const existing: FungusRecord[] = []
const plan = buildRenumberPlan([{ batchIndex: 0, records: fieldNotes }], points, existing)

// 按 (point, year) 分组：BHS-2025, BHS-2026, YLS-2026
const bhs2026 = plan.filter((p) => p.pointId === 'pt_bhs' && p.year === 2026).sort((a, b) => a.seq - b.seq)
assert(bhs2026.length === 3, 'BHS 2026 有 3 条')
assert(bhs2026[0].record.id === 'rec_1' && bhs2026[0].newCode === 'BHS-2026-001', 'BHS-2026-001 是最早日期 rec_1')
assert(bhs2026[1].record.id === 'rec_2' && bhs2026[1].newCode === 'BHS-2026-002', 'BHS-2026-002 是 rec_2')
assert(bhs2026[2].record.id === 'rec_3' && bhs2026[2].newCode === 'BHS-2026-003', 'BHS-2026-003 是 rec_3')

const bhs2025 = plan.filter((p) => p.pointId === 'pt_bhs' && p.year === 2025).sort((a, b) => a.seq - b.seq)
assert(bhs2025.length === 1 && bhs2025[0].newCode === 'BHS-2025-001', 'BHS-2025-001')

const yls2026 = plan.filter((p) => p.pointId === 'pt_yls' && p.year === 2026).sort((a, b) => a.seq - b.seq)
assert(yls2026.length === 1 && yls2026[0].newCode === 'YLS-2026-001', 'YLS-2026-001')

// --- 测试 5: 新号接在已有正式编号之后 ---
const existing2 = [
  makeRecord({ id: 'BHS-2026-001', code: 'BHS-2026-001', pointId: 'pt_bhs', collectDate: '2026-01-01' }),
  makeRecord({ id: 'BHS-2026-002', code: 'BHS-2026-002', pointId: 'pt_bhs', collectDate: '2026-01-02' })
]
const newNotes = [
  makeRecord({ id: 'rec_9', code: 'REC-009', pointId: 'pt_bhs', collectDate: '2026-03-01' })
]
const plan2 = buildRenumberPlan([{ batchIndex: 0, records: newNotes }], points, existing2)
assert(plan2[0].newCode === 'BHS-2026-003', '新号接在已有 002 之后 → BHS-2026-003')

// --- 测试 6: 两批一起交，轮着用号段 ---
const batch1 = [
  makeRecord({ id: 'a1', code: 'REC-A1', pointId: 'pt_bhs', collectDate: '2026-01-01' }),
  makeRecord({ id: 'a2', code: 'REC-A2', pointId: 'pt_bhs', collectDate: '2026-01-03' }),
  makeRecord({ id: 'a3', code: 'REC-A3', pointId: 'pt_bhs', collectDate: '2026-01-05' })
]
const batch2 = [
  makeRecord({ id: 'b1', code: 'REC-B1', pointId: 'pt_bhs', collectDate: '2026-01-02' }),
  makeRecord({ id: 'b2', code: 'REC-B2', pointId: 'pt_bhs', collectDate: '2026-01-04' })
]
const plan3 = buildRenumberPlan(
  [
    { batchIndex: 0, records: batch1 },
    { batchIndex: 1, records: batch2 }
  ],
  points,
  []
)
const bhsAll = plan3.filter((p) => p.pointId === 'pt_bhs' && p.year === 2026).sort((a, b) => a.seq - b.seq)
// 轮着用号段：a1→001, b1→002, a2→003, b2→004, a3→005
assert(bhsAll[0].record.id === 'a1' && bhsAll[0].seq === 1, '轮转 001 → a1')
assert(bhsAll[1].record.id === 'b1' && bhsAll[1].seq === 2, '轮转 002 → b1')
assert(bhsAll[2].record.id === 'a2' && bhsAll[2].seq === 3, '轮转 003 → a2')
assert(bhsAll[3].record.id === 'b2' && bhsAll[3].seq === 4, '轮转 004 → b2')
assert(bhsAll[4].record.id === 'a3' && bhsAll[4].seq === 5, '轮转 005 → a3')
// 新号不重复
const codes = bhsAll.map((p) => p.newCode)
assert(new Set(codes).size === codes.length, '轮转后新号不重复')

// --- 测试 7: 分块 ---
const many = Array.from({ length: 500 }, (_, i) =>
  makeRecord({ id: `rec_${i}`, code: `REC-${i}`, pointId: 'pt_bhs', collectDate: '2026-01-01' })
)
const plan4 = buildRenumberPlan([{ batchIndex: 0, records: many }], points, [])
const chunks = chunkPlan(plan4, 200)
assert(chunks.length === 3, '500 条分 3 批（200/200/100）')
assert(chunks[0].length === 200 && chunks[1].length === 200 && chunks[2].length === 100, '各批大小正确')

// --- 测试 8: 空手记 ---
const plan5 = buildRenumberPlan([{ batchIndex: 0, records: [] }], points, [])
assert(plan5.length === 0, '空手记方案为空')

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
