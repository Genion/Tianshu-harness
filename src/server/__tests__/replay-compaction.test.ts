import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compactReplayRuns,
  compactReplayRunsWithStats,
  isReplayCompactionEnabled,
} from '../replay-compaction.js'
import type { SessionEvent } from '../protocol.js'

/**
 * 回放合并纯函数（桌面性能阶段 1）：连续同类型 delta run 压成一条，
 * 形态与桌面 reducer `coalesceDeltas` 产出一致（seq/ts 取末条、
 * streamStartSeq/streamStartTs 取首条、text 拼接）。
 */

function ev(seq: number, type: SessionEvent['type'], data: Record<string, unknown> = {}): SessionEvent {
  return { seq, ts: 1000 + seq, type, data }
}

test('连续 text_delta 合成一条：seq/ts 取末条，streamStart* 取首条，text 拼接', () => {
  const input = [
    ev(1, 'user', { text: 'q' }),
    ev(2, 'text_delta', { text: 'a' }),
    ev(3, 'text_delta', { text: 'b' }),
    ev(4, 'text_delta', { text: 'c' }),
    ev(5, 'turn_complete', { turnNumber: 1 }),
  ]
  const out = compactReplayRuns(input, { keepOpenTail: true })
  assert.deepEqual(out.map((e) => e.seq), [1, 4, 5])
  const merged = out[1]!
  assert.equal(merged.type, 'text_delta')
  assert.equal(merged.ts, 1004)
  assert.deepEqual(merged.data, { text: 'abc', streamStartSeq: 2, streamStartTs: 1002 })
  // 纯函数：输入未被修改。
  assert.deepEqual(input[1]!.data, { text: 'a' })
  assert.equal(input.length, 5)
})

test('类型切换是边界：thinking_delta 与 text_delta 各成一段', () => {
  const input = [
    ev(1, 'thinking_delta', { text: 't1' }),
    ev(2, 'thinking_delta', { text: 't2' }),
    ev(3, 'text_delta', { text: 'a1' }),
    ev(4, 'text_delta', { text: 'a2' }),
    ev(5, 'done', {}),
  ]
  const out = compactReplayRuns(input, { keepOpenTail: true })
  assert.deepEqual(out.map((e) => [e.seq, e.type]), [[2, 'thinking_delta'], [4, 'text_delta'], [5, 'done']])
  assert.equal(out[0]!.data.text, 't1t2')
  assert.equal(out[0]!.data.streamStartSeq, 1)
  assert.equal(out[1]!.data.text, 'a1a2')
  assert.equal(out[1]!.data.streamStartSeq, 3)
})

test('phase / status 等非 delta 事件是 run 边界且不被剔除', () => {
  const input = [
    ev(1, 'text_delta', { text: 'a' }),
    ev(2, 'text_delta', { text: 'b' }),
    ev(3, 'phase', { phase: 'acting' }),
    ev(4, 'text_delta', { text: 'c' }),
    ev(5, 'text_delta', { text: 'd' }),
    ev(6, 'status', { status: 'running' }),
    ev(7, 'text_delta', { text: 'e' }),
    ev(8, 'text_delta', { text: 'f' }),
    ev(9, 'turn_complete', {}),
  ]
  const out = compactReplayRuns(input, { keepOpenTail: true })
  assert.deepEqual(out.map((e) => e.seq), [2, 3, 5, 6, 8, 9])
  assert.equal(out[0]!.data.text, 'ab')
  assert.equal(out[2]!.data.text, 'cd')
  assert.equal(out[4]!.data.text, 'ef')
  assert.equal(out[1]!.type, 'phase')
  assert.equal(out[3]!.type, 'status')
})

test('keepOpenTail：末段 run 保留原样（会话仍在流式输出）', () => {
  const input = [
    ev(1, 'user', { text: 'q' }),
    ev(2, 'text_delta', { text: 'a' }),
    ev(3, 'text_delta', { text: 'b' }),
    ev(4, 'tool_use', { id: 't1', name: 'read_file', input: {} }),
    ev(5, 'text_delta', { text: 'c' }),
    ev(6, 'text_delta', { text: 'd' }),
  ]
  const hot = compactReplayRuns(input, { keepOpenTail: true })
  assert.deepEqual(hot.map((e) => e.seq), [1, 3, 4, 5, 6], '闭合段合并，末段两条原样保留')
  assert.equal(hot[3]!.data.text, 'c')
  assert.equal(hot[4]!.data.text, 'd')

  const cold = compactReplayRuns(input, { keepOpenTail: false })
  assert.deepEqual(cold.map((e) => e.seq), [1, 3, 4, 6], '冷页末段亦合并')
  assert.equal(cold[3]!.data.text, 'cd')
  assert.equal(cold[3]!.data.streamStartSeq, 5)
})

test('全部是 delta 且 keepOpenTail：整段是开放尾巴 → 原样返回（同一引用）', () => {
  const input = Array.from({ length: 50 }, (_, i) => ev(i + 1, 'text_delta', { text: `t${i}` }))
  const out = compactReplayRuns(input, { keepOpenTail: true })
  assert.equal(out, input as SessionEvent[])
  assert.equal(out.length, 50)
})

test('无可合并 run（单条 delta / 无 delta）→ 原样返回', () => {
  const single = [ev(1, 'user', {}), ev(2, 'text_delta', { text: 'x' }), ev(3, 'done', {})]
  assert.equal(compactReplayRuns(single, { keepOpenTail: false }), single as SessionEvent[])
  const none = [ev(1, 'user', {}), ev(2, 'tool_use', {}), ev(3, 'tool_result', {})]
  assert.equal(compactReplayRuns(none, { keepOpenTail: false }), none as SessionEvent[])
  assert.deepEqual(compactReplayRuns([], {}), [])
})

test('已带 streamStartSeq 的事件（客户端形态）合并时沿用首条的起点', () => {
  const input = [
    ev(5, 'text_delta', { text: 'ab', streamStartSeq: 2, streamStartTs: 1002 }),
    ev(7, 'text_delta', { text: 'cd', streamStartSeq: 6, streamStartTs: 1006 }),
    ev(8, 'done', {}),
  ]
  const out = compactReplayRuns(input, { keepOpenTail: true })
  assert.equal(out.length, 2)
  assert.deepEqual(out[0]!.data, { text: 'abcd', streamStartSeq: 2, streamStartTs: 1002 })
  assert.equal(out[0]!.seq, 7)
})

test('非字符串 text 按 String(x ?? "") 拼接（与 reducer 一致）', () => {
  const input = [
    ev(1, 'text_delta', { text: 'a' }),
    ev(2, 'text_delta', {}),
    ev(3, 'text_delta', { text: 7 }),
    ev(4, 'done', {}),
  ]
  const out = compactReplayRuns(input, { keepOpenTail: true })
  assert.equal(out[0]!.data.text, 'a7')
})

test('seq 单调：合并后 seq 严格递增，末条 seq 不变（客户端 lastSeq 语义不变）', () => {
  const input: SessionEvent[] = []
  let seq = 0
  for (let t = 0; t < 5; t++) {
    input.push(ev(++seq, 'user', { text: `q${t}` }))
    for (let i = 0; i < 20; i++) input.push(ev(++seq, 'thinking_delta', { text: 'x' }))
    input.push(ev(++seq, 'tool_use', { id: `t${t}`, name: 'bash', input: {} }))
    input.push(ev(++seq, 'tool_result', { id: `t${t}`, result: 'ok' }))
    for (let i = 0; i < 30; i++) input.push(ev(++seq, 'text_delta', { text: 'y' }))
    input.push(ev(++seq, 'turn_complete', { turnNumber: t }))
  }
  const { events: out, stats } = compactReplayRunsWithStats(input, { keepOpenTail: true })
  assert.equal(stats.input, input.length)
  assert.equal(stats.output, out.length)
  assert.equal(stats.merged, input.length - out.length)
  assert.equal(out.length, 5 * 6, '每 turn 6 条：user、thinking、tool_use、tool_result、text、turn_complete')
  for (let i = 1; i < out.length; i++) assert.ok(out[i]!.seq > out[i - 1]!.seq)
  assert.equal(out[out.length - 1]!.seq, input[input.length - 1]!.seq)
})

test('isReplayCompactionEnabled：仅 "0" 关闭', () => {
  assert.equal(isReplayCompactionEnabled({}), true)
  assert.equal(isReplayCompactionEnabled({ RIVET_REPLAY_COMPACT: '1' }), true)
  assert.equal(isReplayCompactionEnabled({ RIVET_REPLAY_COMPACT: '' }), true)
  assert.equal(isReplayCompactionEnabled({ RIVET_REPLAY_COMPACT: '0' }), false)
})
