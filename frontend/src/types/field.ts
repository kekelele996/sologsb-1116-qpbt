import type {
  CapMargin,
  CapShape,
  CapTexture,
  FleshReaction,
  GillAttachment,
  GillDensity,
  IdBasis,
  IdConfidence,
  RingType,
  SporeColor,
  VolvaType
} from '@/types'

/** 外业手记条目状态 */
export const FIELD_NOTE_STATUS = ['pending', 'merged'] as const
export type FieldNoteStatus = (typeof FIELD_NOTE_STATUS)[number]

/** 并入任务状态 */
export const MERGE_JOB_STATUS = ['held', 'queued', 'running', 'partial', 'done', 'failed'] as const
export type MergeJobStatus = (typeof MERGE_JOB_STATUS)[number]

/**
 * 外业手记条目。
 * 外业阶段只有临时编号 tempCode，孢子印与鉴定结论都挂在它上面；
 * 并入图谱库后换发正式编号（采集点-年份-序号）。
 */
export interface FieldNote {
  id: string
  /** 临时编号（如 TMP-0007），换号前的唯一业务号 */
  tempCode: string
  tempName: string
  fruitBodyCount: number
  pointId: string
  capDiameter: number
  capShape: CapShape
  capMargin: CapMargin
  capTexture: CapTexture
  fleshThickness: number
  fleshReaction: FleshReaction
  attachment: GillAttachment
  gillDensity: GillDensity
  stipeLength: number
  stipeDiameter: number
  ring: RingType
  volva: VolvaType
  odor: string
  hostTree: string
  collectDate: string
  collector: string
  note: string
  status: FieldNoteStatus
  /** 并入后落入图谱库的正式条目 id */
  mergedRecordId?: string
  /** 并入后换发的正式编号 */
  mergedCode?: string
  /** 并入任务 id */
  jobId?: string
  createdAt: string
}

/** 挂在外业手记（临时号）上的孢子印 */
export interface FieldSporePrint {
  id: string
  /** 指向 FieldNote.id（临时编号条目） */
  noteId: string
  color: SporeColor
  shape: string
  hours: number
  observeDate: string
  moisture: string
}

/** 挂在外业手记（临时号）上的鉴定结论 */
export interface FieldIdentifyLog {
  id: string
  /** 指向 FieldNote.id（临时编号条目） */
  noteId: string
  conclusion: string
  basis: IdBasis
  referenceBook: string
  referencePage: string
  confidence: IdConfidence
  needReview: boolean
  reviewer: string
  date: string
}

/** 一次号段分配：某个采集点 + 年份下，本批次占有的连续序号区间 */
export interface CodeSegment {
  pointCode: string
  year: string
  /** 起始序号（含） */
  start: number
  /** 结束序号（含） */
  end: number
}

/** 并入任务的一个分片（每片一个 Dexie 事务，失败可单独重试） */
export interface MergeChunk {
  /** 分片序号，从 0 开始 */
  index: number
  /** 片内外业手记 id（已按 采集点/年份/日期 排好序） */
  noteIds: string[]
  /** 临时号 → 正式号 */
  assignments: { noteId: string; tempCode: string; code: string; recordId: string }[]
  /** 该片占用的号段 */
  segments: CodeSegment[]
  status: 'pending' | 'done' | 'failed'
  error?: string
}

/** 并入批次（一次上交 = 一个 job） */
export interface MergeJob {
  id: string
  name: string
  status: MergeJobStatus
  /** 队列顺序，越小越先处理 */
  queueOrder: number
  total: number
  /** 已成功并入条数 */
  succeeded: number
  chunkSize: number
  chunks: MergeChunk[]
  /** 演示用：让第 failChunk 个分片首次执行时失败（1 起算），0 表示不注入 */
  failChunk: number
  createdAt: string
  updatedAt: string
  error?: string
}
