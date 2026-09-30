import type { CodeSegment } from '../types/field'

/** 正式采集编号格式：采集点编号-年份-序号，如 BHS-2026-001 */
export const FORMAL_CODE_RE = /^([A-Za-z0-9]+)-(\d{4})-(\d+)$/

/** 采集点编号允许的字符（正式号前缀） */
export const POINT_CODE_RE = /^[A-Za-z0-9]{1,8}$/

export function yearOf(collectDate: string): string {
  const y = (collectDate ?? '').slice(0, 4)
  return /^\d{4}$/.test(y) ? y : ''
}

/** 解析正式编号 */
export function parseFormalCode(code: string): { pointCode: string; year: string; seq: number } | null {
  const m = FORMAL_CODE_RE.exec(code?.trim?.() ?? code)
  if (!m) return null
  return { pointCode: m[1].toUpperCase(), year: m[2], seq: Number(m[3]) }
}

/** 拼正式编号，序号至少 3 位，超出自然变长 */
export function formatCode(pointCode: string, year: string, seq: number): string {
  return `${pointCode.toUpperCase()}-${year}-${String(seq).padStart(3, '0')}`
}

export function groupKey(pointCode: string, year: string): string {
  return `${pointCode.toUpperCase()}__${year}`
}

/** 统计图谱库既有正式编号在各（采集点、年份）下已用到的最大序号 */
export function baselineHighWaters(records: { code: string }[]): Map<string, number> {
  const waters = new Map<string, number>()
  for (const record of records) {
    const parsed = parseFormalCode(record.code)
    if (!parsed) continue
    const key = groupKey(parsed.pointCode, parsed.year)
    waters.set(key, Math.max(waters.get(key) ?? 0, parsed.seq))
  }
  return waters
}

/** 统计已分配号段（含成功/失败/在途分片）在各分组下已占的最大序号；号段一旦分配不回收 */
export function segmentsHighWaters(
  segments: CodeSegment[],
  initial?: Map<string, number>
): Map<string, number> {
  const waters = new Map(initial ?? [])
  for (const seg of segments) {
    const key = groupKey(seg.pointCode, seg.year)
    waters.set(key, Math.max(waters.get(key) ?? 0, seg.end))
  }
  return waters
}

/** 需要参与换号的条目视图：外业手记只有临时号 */
export interface NumberableNote {
  noteId: string
  tempCode: string
  pointCode: string
  collectDate: string
}

export interface CodeAssignment {
  noteId: string
  tempCode: string
  pointCode: string
  year: string
  seq: number
  code: string
  /** 换号后落入图谱库的条目 id，规划时即固定，保证重试幂等 */
  recordId: string
}

export interface JobPlanInput {
  jobId: string
  chunkSize: number
  notes: NumberableNote[]
}

export interface PlannedChunk {
  jobId: string
  chunkIndex: number
  noteIds: string[]
  assignments: CodeAssignment[]
  segments: CodeSegment[]
}

/** 同采集点同年份按采集日期排，日期相同按临时号稳定排序 */
export function sortNumberableNotes(notes: NumberableNote[]): NumberableNote[] {
  return [...notes].sort((a, b) => {
    const pc = a.pointCode.localeCompare(b.pointCode, 'en')
    if (pc !== 0) return pc
    const ya = yearOf(a.collectDate)
    const yb = yearOf(b.collectDate)
    if (ya !== yb) return ya.localeCompare(yb)
    if (a.collectDate !== b.collectDate) return a.collectDate.localeCompare(b.collectDate)
    return a.tempCode.localeCompare(b.tempCode, 'zh-Hans-CN')
  })
}

/**
 * 为一批「一起排队」的上交批次统一规划分片与号段。
 *
 * 规则：
 * - 正式号 = 采集点编号-年份-序号，同一采集点同年份内按日期排序；
 * - 高水位 = 图谱库已有正式号最大序号 ∪ 其他任务（含失败/在途）已占号段，号段不回收；
 * - 多批一起交时，按批次上交先后（queueOrder）轮转：每轮各批交出一个分片，
 *   分片在各（采集点、年份）分组内占用连续号段，从而实现「轮着用号段」。
 */
export function planQueuedJobs(
  inputs: JobPlanInput[],
  options: {
    baseline: Map<string, number>
    occupiedSegments: CodeSegment[]
    genId: () => string
  }
): PlannedChunk[] {
  // 每个批次：按 采集点/年份/日期 排序后切成连续分片
  const jobQueues: NumberableNote[][][] = inputs.map((input) => {
    const size = Math.max(1, input.chunkSize)
    const sorted = sortNumberableNotes(input.notes)
    const chunks: NumberableNote[][] = []
    for (let i = 0; i < sorted.length; i += size) {
      chunks.push(sorted.slice(i, i + size))
    }
    return chunks
  })

  const waters = segmentsHighWaters(options.occupiedSegments, options.baseline)
  const planned: PlannedChunk[] = []

  // 轮转：每轮按上交先后，每个批次取出下一个待排分片顺序发号
  let progressed = true
  while (progressed) {
    progressed = false
    for (let jobIdx = 0; jobIdx < inputs.length; jobIdx++) {
      const queue = jobQueues[jobIdx]
      if (queue.length === 0) continue
      progressed = true
      const chunkNotes = queue.shift()!
      const chunkIndex = planned.filter((c) => c.jobId === inputs[jobIdx].jobId).length
      const assignments: CodeAssignment[] = []
      const segByKey = new Map<string, CodeSegment>()

      for (const note of chunkNotes) {
        const pointCode = note.pointCode.toUpperCase()
        const year = yearOf(note.collectDate)
        const key = groupKey(pointCode, year)
        const seq = (waters.get(key) ?? 0) + 1
        waters.set(key, seq)
        const assignment: CodeAssignment = {
          noteId: note.noteId,
          tempCode: note.tempCode,
          pointCode,
          year,
          seq,
          code: formatCode(pointCode, year, seq),
          recordId: options.genId()
        }
        assignments.push(assignment)
        const seg = segByKey.get(key)
        if (seg) seg.end = seq
        else segByKey.set(key, { pointCode, year, start: seq, end: seq })
      }

      planned.push({
        jobId: inputs[jobIdx].jobId,
        chunkIndex,
        noteIds: chunkNotes.map((n) => n.noteId),
        assignments,
        segments: [...segByKey.values()].sort((a, b) =>
          (a.pointCode + a.year + a.start).localeCompare(b.pointCode + b.year + b.start)
        )
      })
    }
  }

  return planned
}
