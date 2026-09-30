import assert from 'node:assert'
import {
  baselineHighWaters,
  formatCode,
  parseFormalCode,
  planQueuedJobs,
  sortNumberableNotes,
  type JobPlanInput,
  type NumberableNote
} from '../renumber'

let passed = 0
function test(name: string, fn: () => void): void {
  fn()
  passed++
  console.log(`✓ ${name}`)
}

let idSeq = 0
function genId(): string {
  return `rec_test_${++idSeq}`
}

function note(noteId: string, pointCode: string, collectDate: string): NumberableNote {
  return { noteId, tempCode: noteId, pointCode, collectDate }
}

test('parseFormalCode / formatCode 往返', () => {
  assert.deepStrictEqual(parseFormalCode('bhs-2026-7'), { pointCode: 'BHS', year: '2026', seq: 7 })
  assert.strictEqual(formatCode('bhs', '2026', 3), 'BHS-2026-003')
  assert.strictEqual(formatCode('bhs', '2026', 1234), 'BHS-2026-1234')
  assert.strictEqual(parseFormalCode('REC-001'), null)
})

test('同采集点按年份、日期、临时号排序（先点，后年、日）', () => {
  const sorted = sortNumberableNotes([
    note('c', 'BHS', '2026-09-01'),
    note('a', 'BHS', '2026-08-01'),
    note('b', 'BHS', '2025-10-01'),
    note('d', 'BHS', '2026-08-01'),
    note('e', 'YLS', '2026-08-01')
  ]).map((n) => n.noteId)
  assert.deepStrictEqual(sorted, ['b', 'a', 'd', 'c', 'e'])
})

test('图谱库已有正式号形成高水位，新条目从其后继续', () => {
  const baseline = baselineHighWaters([{ code: 'BHS-2026-005' }, { code: 'BHS-2026-002' }, { code: 'X-2019-9' }])
  const inputs: JobPlanInput[] = [
    { jobId: 'j1', chunkSize: 10, notes: [note('a', 'BHS', '2026-05-01'), note('b', 'BHS', '2026-06-01')] }
  ]
  const planned = planQueuedJobs(inputs, { baseline, occupiedSegments: [], genId })
  assert.deepStrictEqual(
    planned[0].assignments.map((a) => a.code),
    ['BHS-2026-006', 'BHS-2026-007']
  )
})

test('单批多片：同点同年按日期连续发号', () => {
  const inputs: JobPlanInput[] = [
    {
      jobId: 'A',
      chunkSize: 2,
      notes: [
        note('a1', 'BHS', '2026-09-02'),
        note('a2', 'BHS', '2026-08-01'),
        note('a3', 'BHS', '2026-09-10'),
        note('a4', 'BHS', '2026-07-01'),
        note('a5', 'YLS', '2026-09-01')
      ]
    }
  ]
  const planned = planQueuedJobs(inputs, { baseline: new Map(), occupiedSegments: [], genId })
  const codes = planned.flatMap((c) => c.assignments.map((a) => a.code))
  assert.deepStrictEqual(codes, [
    'BHS-2026-001', // a4 07-01
    'BHS-2026-002', // a2 08-01
    'BHS-2026-003', // a1 09-02
    'BHS-2026-004', // a3 09-10
    'YLS-2026-001' // a5
  ])
  // 片 1 占 BHS 1~2，片 2 占 BHS 3~4，片 3 占 YLS 1
  assert.deepStrictEqual(planned[0].segments, [{ pointCode: 'BHS', year: '2026', start: 1, end: 2 }])
  assert.deepStrictEqual(planned[1].segments, [{ pointCode: 'BHS', year: '2026', start: 3, end: 4 }])
  assert.deepStrictEqual(planned[2].segments, [{ pointCode: 'YLS', year: '2026', start: 1, end: 1 }])
})

test('两批一起交：按上交先后轮着用号段', () => {
  const mk = (prefix: string, n: number): NumberableNote[] =>
    Array.from({ length: n }, (_, i) => note(`${prefix}${i + 1}`, 'BHS', `2026-08-${String(1 + i).padStart(2, '0')}`))
  const inputs: JobPlanInput[] = [
    { jobId: 'A', chunkSize: 2, notes: mk('a', 6) },
    { jobId: 'B', chunkSize: 2, notes: mk('b', 6) }
  ]
  const planned = planQueuedJobs(inputs, { baseline: new Map(), occupiedSegments: [], genId })
  const byJob = (job: string) =>
    planned
      .filter((c) => c.jobId === job)
      .map((c) => c.segments.find((s) => s.pointCode === 'BHS')!)
  // 轮转顺序：A片1 → B片1 → A片2 → B片2 → A片3 → B片3
  assert.deepStrictEqual(byJob('A'), [
    { pointCode: 'BHS', year: '2026', start: 1, end: 2 },
    { pointCode: 'BHS', year: '2026', start: 5, end: 6 },
    { pointCode: 'BHS', year: '2026', start: 9, end: 10 }
  ])
  assert.deepStrictEqual(byJob('B'), [
    { pointCode: 'BHS', year: '2026', start: 3, end: 4 },
    { pointCode: 'BHS', year: '2026', start: 7, end: 8 },
    { pointCode: 'BHS', year: '2026', start: 11, end: 12 }
  ])
  // 全局无重号、无漏号
  const allSeqs = planned
    .flatMap((c) => c.assignments.map((a) => a.code))
    .map((c) => parseFormalCode(c)!.seq)
    .sort((x, y) => x - y)
  assert.deepStrictEqual(allSeqs, Array.from({ length: 12 }, (_, i) => i + 1))
})

test('失败后重试：已占号段保留，重排规划不回退、不多号', () => {
  // 场景：A 批 4 条（两片），第一片成功（占 1~2），第二片失败。
  // 重试时只重跑失败分片，模拟：成功片号段作为 occupiedSegments 传入下一次规划
  const inputs1: JobPlanInput[] = [
    {
      jobId: 'A',
      chunkSize: 2,
      notes: [note('a1', 'BHS', '2026-08-01'), note('a2', 'BHS', '2026-08-02')]
    }
  ]
  const planned1 = planQueuedJobs(inputs1, { baseline: new Map(), occupiedSegments: [], genId })
  const doneSegment = planned1[0].segments

  // 另一批 B 在 A 失败期间已经成功占用 3~4
  const inputsB: JobPlanInput[] = [
    {
      jobId: 'B',
      chunkSize: 10,
      notes: [note('b1', 'BHS', '2026-08-03'), note('b2', 'BHS', '2026-08-04')]
    }
  ]
  const plannedB = planQueuedJobs(inputsB, { baseline: new Map(), occupiedSegments: doneSegment, genId })
  assert.deepStrictEqual(plannedB[0].assignments.map((a) => a.code), ['BHS-2026-003', 'BHS-2026-004'])

  // A 失败片重试：其原有号段（5~6 在失败时已分配）继续保留 —— 实际实现中失败片 assignments 不变，
  // 这里验证若对剩余条目重新规划（号段已随失败片持久化），不会与 B 的 3~4 冲突
  const inputsRetry: JobPlanInput[] = [
    {
      jobId: 'A-retry',
      chunkSize: 10,
      notes: [note('a3', 'BHS', '2026-08-05'), note('a4', 'BHS', '2026-08-06')]
    }
  ]
  const plannedRetry = planQueuedJobs(inputsRetry, {
    baseline: new Map(),
    occupiedSegments: [...doneSegment, ...plannedB[0].segments],
    genId
  })
  assert.deepStrictEqual(plannedRetry[0].assignments.map((a) => a.code), ['BHS-2026-005', 'BHS-2026-006'])

  const codes = [
    ...planned1.flatMap((c) => c.assignments.map((a) => a.code)),
    ...plannedB.flatMap((c) => c.assignments.map((a) => a.code)),
    ...plannedRetry.flatMap((c) => c.assignments.map((a) => a.code))
  ]
  assert.strictEqual(new Set(codes).size, codes.length, '所有正式号唯一，重试不多出编号')
})

test('不同年份/采集点的序号独立', () => {
  const inputs: JobPlanInput[] = [
    {
      jobId: 'J',
      chunkSize: 10,
      notes: [
        note('a', 'BHS', '2025-01-01'),
        note('b', 'BHS', '2026-01-01'),
        note('c', 'YLS', '2026-01-01')
      ]
    }
  ]
  const planned = planQueuedJobs(inputs, { baseline: new Map(), occupiedSegments: [], genId })
  assert.deepStrictEqual(
    planned[0].assignments.map((a) => a.code),
    ['BHS-2025-001', 'BHS-2026-001', 'YLS-2026-001']
  )
})

console.log(`\n${passed} 个用例全部通过`)
