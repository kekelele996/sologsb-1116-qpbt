import { createStore } from 'zustand/vanilla'
import type { FungusRecord } from '@/types'
import { db } from '@/hooks/usePersistentStore'
import { recordStore } from './recordStore'
import { sporeStore } from './sporeStore'
import { identifyStore } from './identifyStore'
import { pointStore } from './pointStore'
import {
  buildRenumberPlan,
  chunkPlan,
  executeChunk,
  isFieldNote,
  verifyIntegrity,
  type RenumberBatchInput
} from '@/utils/renumber'

const JOB_META_KEY = 'renumber:job'

export interface RenumberJobState {
  status: 'idle' | 'running' | 'done' | 'error'
  total: number
  done: number
  failedChunk: number | null
  orphans: string[]
  startedAt: string | null
  updatedAt: string | null
}

export interface RenumberState {
  /** 外业手记（临时编号）条目 */
  fieldNotes: FungusRecord[]
  /** 已换正式编号的条目数 */
  formalCount: number
  job: RenumberJobState
  running: boolean
  progress: number
  logs: string[]
  hydrate: () => Promise<void>
  /** 并入图谱库：按批次排队分批换号 */
  start: (batches: RenumberBatchInput[]) => Promise<void>
  /** 失败后按批次重试：换好的号留着，只补没换的 */
  retry: () => Promise<void>
  resetJob: () => Promise<void>
}

const initialJob: RenumberJobState = {
  status: 'idle',
  total: 0,
  done: 0,
  failedChunk: null,
  orphans: [],
  startedAt: null,
  updatedAt: null
}

export const renumberStore = createStore<RenumberState>((set, get) => ({
  fieldNotes: [],
  formalCount: 0,
  job: { ...initialJob },
  running: false,
  progress: 0,
  logs: [],

  hydrate: async () => {
    const records = await db.records.toArray()
    const fieldNotes = records.filter(isFieldNote)
    set({ fieldNotes, formalCount: records.length - fieldNotes.length })
    const meta = await db.meta.get(JOB_META_KEY)
    if (meta && meta.value) {
      set({ job: meta.value as RenumberJobState })
    }
  },

  start: async (batches) => {
    set({ running: true, logs: ['开始并入图谱库…'] })
    const now = new Date().toISOString()
    const job: RenumberJobState = {
      status: 'running',
      total: batches.reduce((sum, b) => sum + b.records.length, 0),
      done: 0,
      failedChunk: null,
      orphans: [],
      startedAt: now,
      updatedAt: now
    }
    set({ job })
    await db.meta.put({ key: JOB_META_KEY, value: { ...job } })

    const [records, points] = await Promise.all([db.records.toArray(), db.points.toArray()])
    const existingRecords = records.filter((r) => !isFieldNote(r))
    const plan = buildRenumberPlan(batches, points, existingRecords)
    const chunks = chunkPlan(plan)

    // total 以实际方案数为准（避免进度到不了 100%）
    job.total = plan.length
    await db.meta.put({ key: JOB_META_KEY, value: { ...job } })

    const logs = [`共 ${plan.length} 条手记，分 ${chunks.length} 批排队换号`]
    set({ logs })

    for (let i = 0; i < chunks.length; i++) {
      try {
        await executeChunk(chunks[i], db)
        job.done += chunks[i].length
        job.updatedAt = new Date().toISOString()
        await db.meta.put({ key: JOB_META_KEY, value: { ...job } })
        set({
          job: { ...job },
          progress: Math.round((job.done / Math.max(job.total, 1)) * 100),
          logs: [...logs, `第 ${i + 1}/${chunks.length} 批换号完成（${chunks[i].length} 条）`]
        })
      } catch (e) {
        job.status = 'error'
        job.failedChunk = i
        job.updatedAt = new Date().toISOString()
        await db.meta.put({ key: JOB_META_KEY, value: { ...job } })
        set({
          job: { ...job },
          running: false,
          logs: [...logs, `第 ${i + 1} 批换号失败：${(e as Error).message}。已换好的号保留，可按批次重试。`]
        })
        return
      }
    }

    // 校验引用完整性：孢子印、鉴定结论没有指着旧号
    const { orphans } = await verifyIntegrity(db)
    job.status = orphans.length ? 'error' : 'done'
    job.orphans = orphans
    job.updatedAt = new Date().toISOString()
    await db.meta.put({ key: JOB_META_KEY, value: { ...job } })
    set({
      job: { ...job },
      running: false,
      progress: 100,
      logs: [
        ...logs,
        orphans.length
          ? `换号完成，但发现 ${orphans.length} 条孤立引用：${orphans.join('；')}`
          : '换号完成：孢子印、鉴定结论与采集点统计均已指向新号'
      ]
    })

    await Promise.all([
      recordStore.getState().hydrate(),
      sporeStore.getState().hydrate(),
      identifyStore.getState().hydrate(),
      pointStore.getState().hydrate()
    ])
    await get().hydrate()
  },

  retry: async () => {
    // 重新加载手记：换好的号已是正式编号，不在手记列表里，重交不会多出编号
    const records = await db.records.toArray()
    const fieldNotes = records.filter(isFieldNote)
    if (fieldNotes.length === 0) {
      set({ running: false, logs: ['没有待换号的手记'] })
      return
    }
    // 按批次重试：剩余手记作为一批重新排队
    await get().start([{ batchIndex: 0, records: fieldNotes }])
  },

  resetJob: async () => {
    await db.meta.delete(JOB_META_KEY)
    set({ job: { ...initialJob }, progress: 0, logs: [] })
  }
}))
