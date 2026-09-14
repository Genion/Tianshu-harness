/**
 * Replay-time compaction of closed streaming delta runs.
 *
 * 2026-09-13 桌面冷开会话实测：一个 3.9MB 会话日志里 21,400 个事件中 81% 是
 * `thinking_delta` / `text_delta`（15,211 + 2,073）——append 侧已有 40ms/2KB 的
 * 窗口合并（session-manager `bufferDelta`），所以盘上仍是「每 40ms 一条」。回放
 * 时每条事件是一个 SSE 帧 + 渲染进程一次 JSON.parse + 一次 reduce，首屏 2–3s
 * 里的大头就是这些帧。
 *
 * 这里在**回放出口**（/stream 初始回放、GET /events?since、历史分页）把连续
 * 同类型的 delta run 压成一条：`seq`/`ts` 取 run 末条，`text` 拼接，
 * `data.streamStartSeq` / `data.streamStartTs` 取 run 首条——正是桌面 reducer
 * `coalesceDeltas` 已经在客户端合批时产出的形态（块 key `t-${streamStartSeq}` /
 * `th-${streamStartSeq}`、块 ts 取首条），所以客户端零改动即可消费。
 *
 * 纪律：
 * - 磁盘 `events.jsonl` 与内存环**不动**，只改回放出口的投影；`RIVET_REPLAY_COMPACT=0` 关。
 * - 任何非 delta 事件都是 run 边界，**包括** `phase` / `status`——它们在 reducer 里会
 *   关闭 open 标志，若被剔除，客户端会把两段 run 误合成一块。
 * - 末尾若以 delta 结束（会话仍在流式输出），该 run 按 `keepOpenTail` 决定是否保留
 *   原样：热通道保留（live 追加走客户端 open 标志，与今天一致）；历史分页由
 *   `before` 的存在保证其末段已闭合，可以合并。
 * - `since` 过滤必须发生在合并**之前**（调用方已按 `seq > since` 过滤）：游标落在
 *   run 中间时合并文本只含未见 chunk，客户端仍经 open 标志尾部追加。
 */
import type { SessionEvent } from './protocol.js'

export const REPLAY_DELTA_TYPES: ReadonlySet<string> = new Set(['text_delta', 'thinking_delta'])

export interface CompactReplayOptions {
  /**
   * 窗口末尾若是一段 delta run，保留原样不合并（会话可能仍在流式输出）。
   * 热通道（/stream、/events?since）为 true；历史分页（?before=）为 false。
   */
  keepOpenTail?: boolean
}

export interface CompactReplayStats {
  input: number
  output: number
  /** 被合并进其他事件而消失的 delta 条数。 */
  merged: number
}

/** 逃生口：`RIVET_REPLAY_COMPACT=0` 回到逐条回放。 */
export function isReplayCompactionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RIVET_REPLAY_COMPACT !== '0'
}

function mergeRun(run: readonly SessionEvent[]): SessionEvent {
  const first = run[0]!
  const last = run[run.length - 1]!
  let text = ''
  for (const ev of run) text += String(ev.data.text ?? '')
  const streamStartSeq = typeof first.data.streamStartSeq === 'number' ? first.data.streamStartSeq : first.seq
  const streamStartTs = typeof first.data.streamStartTs === 'number' ? first.data.streamStartTs : first.ts
  return {
    seq: last.seq,
    ts: last.ts,
    type: first.type,
    data: { ...first.data, text, streamStartSeq, streamStartTs },
  }
}

/**
 * 把连续同类型的 `text_delta` / `thinking_delta` 合成一条。纯函数，不修改输入；
 * 输入若不含可合并的 run 则原样返回（同一数组引用），调用方可据此判断是否有变化。
 */
export function compactReplayRuns(
  events: readonly SessionEvent[],
  opts: CompactReplayOptions = {},
): SessionEvent[] {
  const out: SessionEvent[] = []
  let run: SessionEvent[] = []
  let merged = 0

  const flushRun = (asOpenTail: boolean) => {
    if (run.length === 0) return
    if (run.length === 1 || asOpenTail) {
      for (const ev of run) out.push(ev)
    } else {
      out.push(mergeRun(run))
      merged += run.length - 1
    }
    run = []
  }

  for (const ev of events) {
    if (REPLAY_DELTA_TYPES.has(ev.type)) {
      if (run.length > 0 && run[0]!.type !== ev.type) flushRun(false)
      run.push(ev)
      continue
    }
    flushRun(false)
    out.push(ev)
  }
  flushRun(opts.keepOpenTail === true)

  return merged === 0 ? (events as SessionEvent[]) : out
}

/** 带统计的版本——供 /stream 回放日志使用。 */
export function compactReplayRunsWithStats(
  events: readonly SessionEvent[],
  opts: CompactReplayOptions = {},
): { events: SessionEvent[]; stats: CompactReplayStats } {
  const compacted = compactReplayRuns(events, opts)
  return {
    events: compacted,
    stats: { input: events.length, output: compacted.length, merged: events.length - compacted.length },
  }
}
