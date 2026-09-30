import 'fake-indexeddb/auto'
import assert from 'node:assert'
import { db } from '../../hooks/usePersistentStore'
import { mergeJobStore } from '../mergeStore'
import { fieldStore } from '../fieldStore'
import { recordStore } from '../recordStore'
import { sporeStore } from '../sporeStore'
import { identifyStore } from '../identifyStore'
import type { FieldNote, MergeJob } from '../../types'
import { parseFormalCode } from '../../utils/renumber'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeout = 15000, interval = 20 } = {}
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await predicate()) return
    await sleep(interval)
  }
  throw new Error('等待条件超时')
}

let passed = 0
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn()
  passed++
  console.log(`✓ ${name}`)
}

async function pointSeed(): Promise<void> {
  await db.points.bulkPut([
    {
      id: 'pt_bhs',
      code: 'BHS',
      name: '百花山',
      longitude: 115.6,
      latitude: 39.8,
      altitude: 1400,
      vegetation: '针阔混交林',
      substrate: '落叶层',
      companionTrees: '辽东栎',
      collectDate: '2026-08-01',
      collector: '沈禾'
    },
    {
      id: 'pt_yls',
      code: 'YLS',
      name: '云龙山',
      longitude: 117.2,
      latitude: 34.2,
      altitude: 260,
      vegetation: '常绿阔叶林',
      substrate: '腐木',
      companionTrees: '麻栎',
      collectDate: '2026-08-01',
      collector: '沈禾'
    }
  ])
}

async function resetDb(): Promise<void> {
  await db.delete()
  await db.open()
  await pointSeed()
  await Promise.all([
    recordStore.getState().hydrate(),
    sporeStore.getState().hydrate(),
    identifyStore.getState().hydrate(),
    fieldStore.getState().hydrate(),
    mergeJobStore.getState().hydrate()
  ])
}

function makeNote(i: number, pointId = 'pt_bhs', date?: string): FieldNote {
  const d = date ?? `2026-08-${String((i % 28) + 1).padStart(2, '0')}`
  return {
    id: `fnt_t_${i}`,
    tempCode: `TMP-${String(1000 + i)}`,
    tempName: `条目${i}`,
    fruitBodyCount: 1,
    pointId,
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
    hostTree: '',
    collectDate: d,
    collector: '沈禾',
    note: '',
    status: 'pending',
    createdAt: '2026-08-01'
  }
}

async function attach(noteId: string, i: number): Promise<void> {
  await db.fieldSpores.bulkPut([
    { id: `fsp_t_${i}`, noteId, color: '白色', shape: '圆', hours: 8, observeDate: '2026-08-02', moisture: '' }
  ])
  await db.fieldIdentifies.bulkPut([
    {
      id: `fid_t_${i}`,
      noteId,
      conclusion: `Species ${i}`,
      basis: '形态特征',
      referenceBook: '图鉴',
      referencePage: '1',
      confidence: '中',
      needReview: false,
      reviewer: '祁野',
      date: '2026-08-03'
    }
  ])
}

async function getJob(name: string): Promise<MergeJob> {
  const job = (await db.mergeJobs.toArray()).find((j) => j.name === name)
  assert.ok(job, `批次 ${name} 存在`)
  return job as MergeJob
}

async function scenario1(): Promise<void> {
  await test('基本并入：临时号换正式号，孢子印/鉴定结论引用迁移', async () => {
    await resetDb()
    // 库里已有 BHS-2026-005，新号应从 006 起
    await db.records.bulkPut([
      {
        id: 'rec_existing',
        code: 'BHS-2026-005',
        tempName: '旧条目',
        fruitBodyCount: 1,
        pointId: 'pt_bhs',
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
        hostTree: '',
        collectDate: '2026-06-01',
        collector: '',
        note: ''
      }
    ])
    const n1 = makeNote(1, 'pt_bhs', '2026-08-10')
    const n2 = makeNote(2, 'pt_bhs', '2026-08-05')
    await db.fieldNotes.bulkPut([n1, n2])
    await attach(n1.id, 1)
    await attach(n2.id, 2)

    await mergeJobStore.getState().enqueue([n1, n2], { name: 'J1', chunkSize: 10 })
    const job = await getJob('J1')
    await waitFor(async () => (await db.mergeJobs.get(job.id))!.status === 'done')

    const records = await db.records.toArray()
    const newCodes = records.filter((r) => r.id !== 'rec_existing').map((r) => r.code).sort()
    // 同点按日期：n2(08-05) 在 n1(08-10) 前；高水位 5 之后 6、7
    assert.deepStrictEqual(newCodes, ['BHS-2026-006', 'BHS-2026-007'])
    const r006 = records.find((r) => r.code === 'BHS-2026-006')!
    const r007 = records.find((r) => r.code === 'BHS-2026-007')!
    assert.strictEqual(r006.tempName, '条目2')
    assert.strictEqual(r007.tempName, '条目1')

    // 孢子印 / 鉴定结论已指向新条目 id，且不再有挂在临时号上的残留
    const spores = await db.spores.toArray()
    const identifies = await db.identifies.toArray()
    assert.deepStrictEqual(
      spores.map((s) => s.recordId).sort(),
      [r006.id, r007.id].sort()
    )
    assert.deepStrictEqual(
      identifies.map((s) => s.recordId).sort(),
      [r006.id, r007.id].sort()
    )
    assert.strictEqual(await db.fieldSpores.count(), 0)
    assert.strictEqual(await db.fieldIdentifies.count(), 0)

    const notes = await db.fieldNotes.toArray()
    assert.ok(notes.every((n) => n.status === 'merged' && n.mergedCode))
    assert.strictEqual(notes.find((n) => n.id === n1.id)!.mergedCode, 'BHS-2026-007')
  })
}

async function scenario2(): Promise<void> {
  await test('分片失败：按批次重试，成功片保留，不重号不多号', async () => {
    await resetDb()
    const notes = Array.from({ length: 5 }, (_, k) => makeNote(k + 1, 'pt_bhs', `2026-09-0${k + 1}`))
    await db.fieldNotes.bulkPut(notes)
    await attach(notes[0].id, 1)

    await mergeJobStore.getState().enqueue(notes, { name: 'JF', chunkSize: 2, failChunk: 2 })
    const jobRow = await getJob('JF')
    await waitFor(async () =>
      ['partial', 'done'].includes((await db.mergeJobs.get(jobRow.id))!.status)
    )
    let job = (await db.mergeJobs.get(jobRow.id))!
    assert.strictEqual(job.status, 'partial')
    assert.strictEqual(job.chunks[0].status, 'done')
    assert.strictEqual(job.chunks[1].status, 'failed')
    assert.strictEqual(job.chunks[2].status, 'pending')
    assert.strictEqual(job.succeeded, 2)

    // 成功的 2 条已入库，号为 001、002
    const codesAfterFail = (await db.records.toArray()).map((r) => parseFormalCode(r.code)!.seq).sort()
    assert.deepStrictEqual(codesAfterFail, [1, 2])

    // 按批次重试：只重发失败片（成功片不动），随后第 3 片继续，最终 001~005 连续
    await mergeJobStore.getState().retryJob(job.id)
    await waitFor(async () => (await db.mergeJobs.get(jobRow.id))!.status === 'done')
    job = (await db.mergeJobs.get(jobRow.id))!
    assert.strictEqual(job.succeeded, 5)
    const seqs = (await db.records.toArray())
      .map((r) => parseFormalCode(r.code)!)
      .sort((a, b) => a.seq - b.seq)
    assert.deepStrictEqual(
      seqs.map((s) => s.seq),
      [1, 2, 3, 4, 5]
    )
    assert.strictEqual(new Set(seqs.map((s) => s.pointCode + s.seq)).size, 5)
    // 挂在第 1 条上的孢子印最终正确迁移（重试不重复写入）
    const spores = await db.spores.toArray()
    assert.strictEqual(spores.length, 1)
    const linked = (await db.records.toArray()).find((r) => r.id === spores[0].recordId)!
    assert.strictEqual(linked.collectDate, '2026-09-01')
    // 再次重试无失败片时应报错
    await assert.rejects(() => mergeJobStore.getState().retryJob(job.id), /没有失败分片/)
  })
}

async function scenario3(): Promise<void> {
  await test('两批一起交：同点同年号段按上交先后轮转', async () => {
    await resetDb()
    const a = Array.from({ length: 4 }, (_, k) => makeNote(100 + k, 'pt_bhs', `2026-07-0${k + 1}`))
    const b = Array.from({ length: 4 }, (_, k) => makeNote(200 + k, 'pt_bhs', `2026-08-0${k + 1}`))
    a.forEach((n, k) => {
      n.tempCode = `TA-${k + 1}`
    })
    b.forEach((n, k) => {
      n.tempCode = `TB-${k + 1}`
    })
    await db.fieldNotes.bulkPut([...a, ...b])

    await mergeJobStore.getState().enqueue(a, { name: 'BATCH-A', chunkSize: 2, hold: true })
    await mergeJobStore.getState().enqueue(b, { name: 'BATCH-B', chunkSize: 2, hold: true })
    mergeJobStore.getState().startQueue()

    const ja = await getJob('BATCH-A')
    const jb = await getJob('BATCH-B')
    await waitFor(
      async () =>
        (await db.mergeJobs.get(ja.id))!.status === 'done' &&
        (await db.mergeJobs.get(jb.id))!.status === 'done'
    )
    const rangesOf = async (id: string): Promise<Array<[number, number]>> =>
      (await db.mergeJobs.get(id))!.chunks.map((c) => {
        const seg = c.segments.find((s) => s.pointCode === 'BHS')!
        return [seg.start, seg.end] as [number, number]
      })
    // A 先交：1-2、5-6；B 后交：3-4、7-8
    assert.deepStrictEqual(await rangesOf(ja.id), [
      [1, 2],
      [5, 6]
    ])
    assert.deepStrictEqual(await rangesOf(jb.id), [
      [3, 4],
      [7, 8]
    ])
    const seqs = (await db.records.toArray())
      .map((r) => parseFormalCode(r.code)!.seq)
      .sort((x, y) => x - y)
    assert.deepStrictEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8])
  })
}

async function scenario4(): Promise<void> {
  await test('大批量（>1000）：排队分批，全部换号且引用一致', async () => {
    await resetDb()
    const notes = Array.from({ length: 2500 }, (_, k) => makeNote(k + 1))
    await db.fieldNotes.bulkPut(notes)
    for (const n of notes) {
      const idx = Number(n.tempCode.slice(4))
      if (idx % 3 === 0) await attach(n.id, idx)
    }

    await mergeJobStore.getState().enqueue(notes, { name: 'BIG' })
    const jobRow = await getJob('BIG')
    await waitFor(async () => (await db.mergeJobs.get(jobRow.id))!.status === 'done', {
      timeout: 60000
    })
    const job = (await db.mergeJobs.get(jobRow.id))!
    assert.strictEqual(job.total, 2500)
    assert.strictEqual(job.succeeded, 2500)
    assert.ok(job.chunks.length >= 12, `应分为多个分片，实际 ${job.chunks.length}`)
    assert.ok(job.chunks.every((c) => c.status === 'done'))

    assert.strictEqual(await db.records.count(), 2500)
    assert.strictEqual(await db.fieldNotes.where('status').equals('pending').count(), 0)
    // 全部正式号唯一连续
    const seqs = (await db.records.toArray()).map((r) => parseFormalCode(r.code)!.seq)
    assert.strictEqual(new Set(seqs).size, 2500)
    assert.strictEqual(Math.max(...seqs), 2500)
    assert.strictEqual(Math.min(...seqs), 1)
    assert.strictEqual(await db.fieldSpores.count(), 0)
    assert.ok((await db.spores.count()) > 0)
    // 每条孢子印都能找到对应正式条目，不存在指向旧临时号/不存在条目的悬挂引用
    const recordIds = new Set((await db.records.toArray()).map((r) => r.id))
    for (const spore of await db.spores.toArray()) {
      assert.ok(recordIds.has(spore.recordId), `孢子印 ${spore.id} 引用了不存在的条目`)
    }
  })
}

async function scenario5(): Promise<void> {
  await test('换号中途再交一批：在途号段视为占用，不撞号', async () => {
    await resetDb()
    // 第一批 400 条（200/片，共 2 片）；在第 1 片完成、第 2 片在途时上交第二批
    const batch1 = Array.from({ length: 400 }, (_, k) => makeNote(k + 1, 'pt_bhs', `2026-05-${String((k % 28) + 1).padStart(2, '0')}`))
    await db.fieldNotes.bulkPut(batch1)
    await mergeJobStore.getState().enqueue(batch1, { name: 'RUN', chunkSize: 200 })
    const run = await getJob('RUN')
    // 等到第 1 片完成（已占 1~200）
    await waitFor(async () => {
      const j = await db.mergeJobs.get(run.id)
      return !!j && j.chunks[0]?.status === 'done'
    })

    // 此时立刻交第二批 50 条：规划必须把 RUN 的在途号段（201~400）算作占用
    const batch2 = Array.from({ length: 50 }, (_, k) => {
      const n = makeNote(500 + k, 'pt_bhs', `2026-06-${String((k % 28) + 1).padStart(2, '0')}`)
      n.tempCode = `LATE-${k + 1}`
      return n
    })
    await db.fieldNotes.bulkPut(batch2)
    await mergeJobStore.getState().enqueue(batch2, { name: 'LATE', chunkSize: 50 })

    await Promise.all([
      waitFor(async () => (await db.mergeJobs.get(run.id))!.status === 'done', { timeout: 30000 }),
      waitFor(async () => (await db.mergeJobs.get((await getJob('LATE')).id))!.status === 'done', {
        timeout: 30000
      })
    ])

    const all = await db.records.toArray()
    assert.strictEqual(all.length, 450)
    const seqs = all.map((r) => parseFormalCode(r.code)!.seq)
    assert.strictEqual(new Set(seqs).size, 450, '两批正式号不重号')
    assert.strictEqual(Math.min(...seqs), 1)
    assert.strictEqual(Math.max(...seqs), 450, '第二批在两批总量处续号，不与在途号段重叠')
  })
}

async function main(): Promise<void> {
  await scenario1()
  await scenario2()
  await scenario3()
  await scenario4()
  await scenario5()
  console.log(`\n集成测试：${passed} 个场景全部通过`)
}

void main()
