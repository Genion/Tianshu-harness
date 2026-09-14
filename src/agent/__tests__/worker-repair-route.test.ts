/**
 * shouldUseContextFreeRepair —— 无历史 JSON 修复通道的准入契约。
 *
 * 现场（2026-09-13）：审查 worker 探索 15 轮 / 31 次工具调用后终轮产出散文，
 * 主 parse 失败 → 进无历史单发修复 → 模型看不见自己的工具调用记录 → 写出
 * "未获得工单正文/无工具调用能力"的合法 JSON → 被当作正式结论渲染进 advisory。
 *
 * 判据核心一格：**探索过就不许走无历史通道**（toolUseCount > 0 → false）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldUseContextFreeRepair } from '../worker-repair-route.js'

test('零探索（0 次工具调用）允许无历史修复——无历史可丢，这正是该通道的适用场景', () => {
  assert.equal(
    shouldUseContextFreeRepair({ toolUseCount: 0, forceJsonRepair: true, abortLatched: false }),
    true,
  )
})

test('探索过（>0 次工具调用）禁止无历史修复——否则模型看不见自己的工具调用，只能编造或自述"没上下文"', () => {
  for (const toolUseCount of [1, 3, 31]) {
    assert.equal(
      shouldUseContextFreeRepair({ toolUseCount, forceJsonRepair: true, abortLatched: false }),
      false,
      `toolUseCount=${toolUseCount} 时不得进无历史修复`,
    )
  }
})

test('provider 拒绝 response_format 时通道关闭', () => {
  assert.equal(
    shouldUseContextFreeRepair({ toolUseCount: 0, forceJsonRepair: false, abortLatched: false }),
    false,
  )
})

test('已中止时不花任何 API（由上层 salvage 阶梯接管）', () => {
  assert.equal(
    shouldUseContextFreeRepair({ toolUseCount: 0, forceJsonRepair: true, abortLatched: true }),
    false,
  )
})
