import { createStore } from 'zustand/vanilla'
import type {
  FieldNote,
  FungusRecord,
  IdentifyLog,
  MergeChunk,
  MergeJob,
  SporePrint
} from '@/types'
import { db } from '@/hooks/usePersistentStore'
import { recordStore } from '@/stores/recordStore'
import { sporeStore } from '@/stores/sporeStore'
import { identifyStore } from '@/stores/identifyStore'
import { fieldStore } from '@/stores/fieldStore'
import { uid } from '@/utils/id'
import {
  baselineHighWaters,
  planQueuedJobs,
  type NumberableNote
} from '@/utils/renumber'

/** 一次上交超过该条数算大批量：先排队、再分片换号 */
export const LARGE_BATCH_THRESHOLD = 1000
/** 大批量时每个分片（一个数据库事务）的条目数 */
export const LARGE_BATCH_CHUNK = 200

export interface EnqueueOptions {
  name: string
  /** 演示用：让第 failChunk 个分片首次执行时失败（1 起算），0 不注入 */
  failChunk?: number
  /** 自定义分片大小，默认大批量 200，小批量一片 */
  chunkSize?: number
  /** true = 只排队暂不执行，可再攒一批，最后手动 startQueue 一起轮转发号 */
  hold?: boolean
}

export interface MergeJobState {
  jobs: MergeJob[]
  loaded: boolean
  hydrate: () => Promise<void>
  enqueue: (notes: FieldNote[], options: EnqueueOptions) => Promise<MergeJob>
  startQueue: () => void
  resumeOnStartup: () => Promise<void>
  retryJob: (jobId: string) => Promise<void>
  removeJob: (jobId: string) => Promise<void>
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function now(): string {
  return new Date().toISOString()
}

/** 让排队中的任务统一重新规划分片，实现多批同交时按上交先后轮转发号 */
async function planAllHeld(): Promise<void> {
  const queued = await db.mergeJobs.where('status').equals('held').sortBy('queueOrder')
  if (queued.length === 0) return

  const pointCodeById = new Map((await db.points.toArray()).map((point) => [point.id, point.code]))

  const inputs = []
  for (const job of queued) {
    const notes = await db.fieldNotes.where('jobId').equals(job.id).toArray()
    const numberable: NumberableNote[] = notes
      .filter((note) => note.status === 'pending')
      .map((note) => ({
        noteId: note.id,
        tempCode: note.tempCode,
        pointCode: pointCodeById.get(note.pointId) ?? '',
        collectDate: note.collectDate
      }))
    inputs.push({
      jobId: job.id,
      chunkSize: job.chunkSize,
      notes: numberable
    })
  }

  // 基线高水位（图谱库正式号）+ 其他任务已占号段：
  // held 批之间一起轮转（互相不视为占用）；queued/running/partial 批（含在途、失败片）
  // 的号段都已分配、不回收，必须计入，防止换号中途再交一批时撞号
  const records = await db.records.toArray()
  const otherJobs = (await db.mergeJobs.toArray()).filter((job) => job.status !== 'held')
  const occupied = otherJobs.flatMap((job) => job.chunks.flatMap((chunk) => chunk.segments))
  const planned = planQueuedJobs(inputs, {
    baseline: baselineHighWaters(records),
    occupiedSegments: occupied,
    genId: uid
  })

  for (const job of queued) {
    const chunks: MergeChunk[] = planned
      .filter((plan) => plan.jobId === job.id)
      .map((plan) => ({
        index: plan.chunkIndex,
        noteIds: plan.noteIds,
        assignments: plan.assignments.map((a) => ({
          noteId: a.noteId,
          tempCode: a.tempCode,
          code: a.code,
          recordId: a.recordId
        })),
        segments: plan.segments,
        status: 'pending' as const
      }))
    job.chunks = chunks
    job.total = chunks.reduce((sum, chunk) => sum + chunk.assignments.length, 0)
    // held → queued：号段规划完成，进入执行队列（顺序保持 queueOrder）
    job.status = 'queued'
    job.updatedAt = now()
    await db.mergeJobs.put(job)
  }
}

/** 执行单个分片：一个事务完成「换号 + 孢子印/鉴定结论引用迁移」，返回本次实际新并入条数 */
async function runChunk(job: MergeJob, chunk: MergeChunk): Promise<number> {
  let newlyMerged = 0
  await db.transaction(
    'rw',
    [
      db.records,
      db.spores,
      db.identifies,
      db.fieldNotes,
      db.fieldSpores,
      db.fieldIdentifies
    ],
    async () => {
      for (const assignment of chunk.assignments) {
        const note = await db.fieldNotes.get(assignment.noteId)
        if (!note) throw new Error(`外业手记 ${assignment.tempCode} 已不存在`)
        if (note.status === 'merged') {
          // 幂等兜底：已换号成功的条目直接沿用，不再新增编号
          if (note.mergedRecordId !== assignment.recordId) {
            throw new Error(`临时号 ${assignment.tempCode} 已并入其他正式条目`)
          }
          continue
        }

        const {
          // 剥离外业专用字段，其余形态字段原样转入图谱条目
          id: _id,
          tempCode: _tempCode,
          status: _status,
          mergedRecordId: _m1,
          mergedCode: _m2,
          jobId: _jobId,
          createdAt: _createdAt,
          ...morphology
        } = note

        const record: FungusRecord = {
          id: assignment.recordId,
          code: assignment.code,
          ...morphology
        }
        await db.records.put(record)
        newlyMerged++

        // 孢子印从临时号迁移到新正式条目，引用跟着换
        const attachedSpores = await db.fieldSpores.where('noteId').equals(note.id).toArray()
        for (const spore of attachedSpores) {
          const row: SporePrint = {
            id: spore.id,
            recordId: assignment.recordId,
            color: spore.color,
            shape: spore.shape,
            hours: spore.hours,
            observeDate: spore.observeDate,
            moisture: spore.moisture
          }
          await db.spores.put(row)
        }
        await db.fieldSpores.where('noteId').equals(note.id).delete()

        // 鉴定结论同样迁移到新正式条目
        const attachedIdentifies = await db.fieldIdentifies.where('noteId').equals(note.id).toArray()
        for (const log of attachedIdentifies) {
          const row: IdentifyLog = {
            id: log.id,
            recordId: assignment.recordId,
            conclusion: log.conclusion,
            basis: log.basis,
            referenceBook: log.referenceBook,
            referencePage: log.referencePage,
            confidence: log.confidence,
            needReview: log.needReview,
            reviewer: log.reviewer,
            date: log.date
          }
          await db.identifies.put(row)
        }
        await db.fieldIdentifies.where('noteId').equals(note.id).delete()

        await db.fieldNotes.put({
          ...note,
          status: 'merged',
          mergedRecordId: assignment.recordId,
          mergedCode: assignment.code
        })
      }
    }
  )

  chunk.status = 'done'
  chunk.error = undefined
  // 仅按本次实际新并入数累加：分片重试时已 merged 的条目不重复计数
  job.succeeded += newlyMerged
  job.updatedAt = now()
  await db.mergeJobs.put(job)
  return newlyMerged
}

async function refreshStores(): Promise<void> {
  await Promise.all([
    recordStore.getState().hydrate(),
    sporeStore.getState().hydrate(),
    identifyStore.getState().hydrate(),
    fieldStore.getState().hydrate(),
    mergeJobStore.getState().hydrate()
  ])
}

let queueRunning = false
let runQueued = false
let runToken = 0

/** 应用启动时恢复：上次中断在 running 的批次按其分片状态复位，失败片保留等待重试 */
async function resumeInterruptedJobs(): Promise<void> {
  const running = await db.mergeJobs.where('status').equals('running').toArray()
  for (const job of running) {
    const hasFailed = job.chunks.some((chunk) => chunk.status === 'failed')
    const hasPending = job.chunks.some((chunk) => chunk.status === 'pending')
    job.status = hasFailed ? 'partial' : hasPending ? 'queued' : 'done'
    job.updatedAt = now()
    await db.mergeJobs.put(job)
  }
}

/** 队列执行器：按上交先后处理，分片间让出事件循环，失败分片保留现场 */
async function pumpQueue(): Promise<void> {
  const token = ++runToken
  while (true) {
    const jobs = await db.mergeJobs
      .where('status')
      .anyOf('queued', 'running')
      .sortBy('queueOrder')
    // 存在失败分片的批次必须等用户「按批次重试」，不再自动续跑（重试只重发失败片，成功片与号段保留）
    const actionable = jobs.filter(
      (job) =>
        !job.chunks.some((chunk) => chunk.status === 'failed') &&
        job.chunks.some((chunk) => chunk.status === 'pending')
    )
    if (actionable.length === 0) break

    for (const job of actionable) {
      if (token !== runToken) return // 重排队期间作废本轮
      if (job.status === 'queued') {
        job.status = 'running'
        job.error = undefined
        await db.mergeJobs.put(job)
      }

      for (const chunk of job.chunks) {
        if (chunk.status !== 'pending') continue

        // 演示故障注入：仅在首次执行该分片时触发，重试不再失败
        if (job.failChunk > 0 && chunk.index + 1 === job.failChunk) {
          job.failChunk = 0
          chunk.status = 'failed'
          chunk.error = `模拟故障：第 ${chunk.index + 1} 个分片换号中途失败（号段已保留）`
          job.status = 'partial'
          job.error = chunk.error
          job.updatedAt = now()
          await db.mergeJobs.put(job)
          await refreshStores()
          break
        }

        try {
          await runChunk(job, chunk)
        } catch (err) {
          chunk.status = 'failed'
          chunk.error = err instanceof Error ? err.message : String(err)
          job.status = 'partial'
          job.error = chunk.error
          job.updatedAt = now()
          await db.mergeJobs.put(job)
          await refreshStores()
          break
        }
        await refreshStores()
        await sleep(0)
      }

      if (token !== runToken) return

      const fresh = await db.mergeJobs.get(job.id)
      if (!fresh) continue
      const failed = fresh.chunks.filter((chunk) => chunk.status === 'failed').length
      const pending = fresh.chunks.filter((chunk) => chunk.status === 'pending').length
      if (failed === 0 && pending === 0) {
        fresh.status = 'done'
        fresh.error = undefined
      } else if (failed > 0) {
        fresh.status = 'partial'
      }
      fresh.updatedAt = now()
      await db.mergeJobs.put(fresh)
      await refreshStores()
    }
  }
}

function schedulePump(): void {
  runQueued = true
  void (async () => {
    // 让出一个 tick：同一时刻连续上交的两批会被一起重新规划（轮转发号）
    await sleep(30)
    if (queueRunning) return
    queueRunning = true
    try {
      while (runQueued) {
        runQueued = false
        await pumpQueue()
      }
    } finally {
      queueRunning = false
      if (runQueued) schedulePump()
    }
  })()
}

export const mergeJobStore = createStore<MergeJobState>((set, get) => ({
  jobs: [],
  loaded: false,

  hydrate: async () => {
    const jobs = await db.mergeJobs.toArray()
    jobs.sort((a, b) => a.queueOrder - b.queueOrder || b.createdAt.localeCompare(a.createdAt))
    set({ jobs, loaded: true })
  },

  enqueue: async (notes, options) => {
    if (notes.length === 0) throw new Error('没有可上交的外业手记')
    const pending = notes.filter((note) => note.status === 'pending')
    if (pending.length !== notes.length) {
      throw new Error('只能上交尚未并入的手记条目')
    }
    if (pending.some((note) => note.jobId)) {
      throw new Error('存在已在并入队列中的手记，请勿重复上交')
    }
    const tempCodes = new Set<string>()
    for (const note of pending) {
      if (tempCodes.has(note.tempCode)) throw new Error(`临时号重复：${note.tempCode}`)
      tempCodes.add(note.tempCode)
      if (!/^\d{4}-/.test(note.collectDate)) {
        throw new Error(`手记 ${note.tempCode} 采集日期无效，无法确定年份`)
      }
    }
    const points = await db.points.toArray()
    const pointCodeById = new Map(points.map((point) => [point.id, point.code]))
    for (const note of pending) {
      const code = pointCodeById.get(note.pointId)
      if (!code || !/^[A-Za-z0-9]+$/.test(code)) {
        throw new Error(`手记 ${note.tempCode} 所属采集点缺少有效编号前缀`)
      }
    }

    const lastJob = await db.mergeJobs.orderBy('queueOrder').last()
    const queueOrder = (lastJob?.queueOrder ?? 0) + 1
    const chunkSize = options.chunkSize ?? (pending.length > LARGE_BATCH_THRESHOLD ? LARGE_BATCH_CHUNK : pending.length)

    const ts = now()
    const job: MergeJob = {
      id: uid('job'),
      name: options.name || `并入批次 ${ts.slice(0, 10)}`,
      // 先以 held 占位：立即执行时与队列中其他 held 批一起按上交先后轮转规划；hold 则等待手动开排
      status: 'held',
      queueOrder: queueOrder + 1,
      total: pending.length,
      succeeded: 0,
      chunkSize,
      chunks: [],
      failChunk: options.failChunk ?? 0,
      createdAt: ts,
      updatedAt: ts
    }

    await db.transaction('rw', db.mergeJobs, db.fieldNotes, async () => {
      await db.mergeJobs.put(job)
      for (const note of pending) {
        await db.fieldNotes.put({ ...note, jobId: job.id })
      }
    })
    // 规划在事务外（需读 points/records 等表）：held 占位已落库，即便规划中断也可稍后手动开排
    if (!options.hold) {
      // 立即上交：与此前挂起攒批的批次一起统一轮转发号，随后全部转为 queued
      await planAllHeld()
    }

    await get().hydrate()
    await fieldStore.getState().hydrate()
    if (!options.hold) schedulePump()
    return (await db.mergeJobs.get(job.id))!
  },

  startQueue: () => {
    void (async () => {
      await planAllHeld()
      await mergeJobStore.getState().hydrate()
      schedulePump()
    })()
  },

  resumeOnStartup: async () => {
    await resumeInterruptedJobs()
    await get().hydrate()
    // 有排队中（未失败）的分片时自动续跑
    const queued = await db.mergeJobs.where('status').equals('queued').toArray()
    if (queued.some((job) => job.chunks.some((chunk) => chunk.status === 'pending'))) {
      schedulePump()
    }
  },

  retryJob: async (jobId) => {
    const job = await db.mergeJobs.get(jobId)
    if (!job) throw new Error('批次不存在')
    const hasFailed = job.chunks.some((chunk) => chunk.status === 'failed')
    if (!hasFailed) throw new Error('该批次没有失败分片，无需重试')
    // 只重置失败分片；已成功分片与已分配号段原样保留，重试不会多出编号
    job.chunks = job.chunks.map((chunk) =>
      chunk.status === 'failed' ? { ...chunk, status: 'pending', error: undefined } : chunk
    )
    job.status = 'queued'
    job.error = undefined
    job.updatedAt = now()
    await db.mergeJobs.put(job)
    await get().hydrate()
    schedulePump()
  },

  removeJob: async (jobId) => {
    const job = await db.mergeJobs.get(jobId)
    if (!job) return
    if (job.status === 'queued' || job.status === 'running') {
      throw new Error('批次尚在队列中处理，不能删除')
    }
    await db.transaction('rw', db.mergeJobs, db.fieldNotes, async () => {
      // 释放尚未成功分片对应手记的占用，允许重新上交（已成功的手记保持 merged）
      const failedNoteIds = job.chunks
        .filter((chunk) => chunk.status !== 'done')
        .flatMap((chunk) => chunk.assignments.map((a) => a.noteId))
      for (const noteId of failedNoteIds) {
        const note = await db.fieldNotes.get(noteId)
        if (note && note.status === 'pending') {
          await db.fieldNotes.put({ ...note, jobId: undefined })
        }
      }
      await db.mergeJobs.delete(jobId)
    })
    await get().hydrate()
    await fieldStore.getState().hydrate()
  }
}))
