/**
 * worker-report-source —— 结果来源标记，让下游能区分「真实报告」与「系统打捞产物」。
 *
 * 现场（2026-09-13）：一段来自无历史修复轮的自述通过了 parse，被下游当作 worker 的
 * 正式结论渲染进 advisory；结果契约层没有任何字段能让消费方看出它的来源。本文件
 * 钉住三个写入点：打捞（salvaged）、结构化 blocked（blocked）、以及无历史修复回填
 * （repaired，在 worker-session 集成路径上验证）。
 *
 * 纪律：`reportSource` 只进内部 `workerResultSchema`，**不进** `workerResultIngestSchema`
 * ——后者是 worker 自报入口，来源由系统盖章，worker 不得自称 live（与 objective 的
 * 处理同源，见 work-order.ts:305 注释）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildBlockedWorkerResult, salvageWorkerResult, workerResultSchema } from '../work-order.js'
import type { WorkOrder } from '../work-order.js'

function order(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id: 'wo-src-test',
    kind: 'review',
    objective: '审查某改动',
    context: '',
    files: [],
    budget: { maxTurns: 12, maxRetries: 0, maxTokens: 4096 },
    ...overrides,
  } as WorkOrder
}

test('schema 接受 reportSource 五取值，且该字段可选（既有产物不受影响）', () => {
  const base = buildBlockedWorkerResult(order(), 'blocked for test')
  for (const source of ['live', 'finalized', 'repaired', 'salvaged', 'blocked'] as const) {
    const parsed = workerResultSchema.safeParse({ ...base, reportSource: source })
    assert.equal(parsed.success, true, `${source} 应被 schema 接受`)
  }
  const withoutField = workerResultSchema.safeParse({ ...base })
  assert.equal(withoutField.success, true, 'reportSource 缺省时应仍可解析')
})

test('结构化 blocked 结果标记 reportSource=blocked', () => {
  const result = buildBlockedWorkerResult(order(), 'budget exhausted')
  assert.equal(result.reportSource, 'blocked')
})

test('字段级打捞产物标记 reportSource=salvaged（下游据此不把它当正式结论）', () => {
  // 缺必填 workOrderId/status，但 findings 数组可救——典型 malformed 报告
  const malformed = JSON.stringify({
    findings: [{ claim: 'count 无 range 必失败', evidence: 'src/a.ts:12', confidence: 'high' }],
  })
  const result = salvageWorkerResult(malformed, 'wo-src-test')
  assert.ok(result, '该输入应可打捞')
  assert.equal(result.reportSource, 'salvaged')
})

test('产出的来源标记能被 schema 回环解析（不因新增字段破坏契约）', () => {
  const salvaged = salvageWorkerResult(
    JSON.stringify({ findings: [{ claim: 'x', evidence: 'y', confidence: 'low' }] }),
    'wo-src-test',
  )
  assert.ok(salvaged)
  assert.equal(workerResultSchema.safeParse(salvaged).success, true)
})
