/**
 * infra-failure-classification —— 审查失败归类器的判据边界（2026-09-13 误分类现场）。
 *
 * 现场：一次提交后审查被标成 `kind=json`（"报告解析失败"），但 worker 那段自述
 * 里根本没有 parse 字样——说明命中来自 `risks` 或 `artifacts` 里的偶然字面。
 * 原实现把 summary + risks + artifacts 拼成一个大字符串后正则首命中即定类，
 * 于是「报告正文说了什么」与「归类成什么」之间没有稳定关系；该 kind 还会流入
 * /status 健康面板（review-health.ts）。
 *
 * 判据：只按 summary 定类——它是 worker 对本次失败的正式陈述，risks/artifacts
 * 是附带产物，不应左右归类。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyInfraFailure } from '../review-coordinator-deps.js'
import type { WorkerResult } from '../work-order.js'

function worker(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    workOrderId: 'wo-test',
    status: 'blocked',
    summary: 'blocked',
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'unverified',
    ...overrides,
  }
}

test('summary 干净而 risks 里出现 parse 字样时，不得归为 json（回归误分类）', () => {
  const result = worker({
    summary: '本次运行未获得工单正文、仓库访问或任何工具调用能力，无法核查证据，故如实报告为阻塞而非通过。',
    risks: ['上游 parse 阶段偶发失败，与本轮证据无关'],
  })
  assert.equal(classifyInfraFailure(result), 'worker')
})

test('结构化 failureReason 优先：summary 没有任何 JSON 字样时也能正确归为 json', () => {
  const result = worker({
    summary: 'Worker report was malformed; salvaged 2/3 candidate(s) as findings',
    risks: ['parse-salvaged: 2 finding(s) recovered from a malformed report'],
    failureReason: 'json_parse',
  })
  assert.equal(classifyInfraFailure(result), 'json')
})

test('结构化 failureReason=max_turns 时归为 budget（不依赖 summary 措辞）', () => {
  assert.equal(
    classifyInfraFailure(worker({ summary: 'worker stopped early', failureReason: 'max_turns' })),
    'budget',
  )
})

test('summary 干净而 artifacts 里出现 parse 字样时，同样不得归为 json', () => {
  const result = worker({
    summary: 'worker 未能产出可核查的结论。',
    artifacts: [{ kind: 'note', title: 'raw', content: 'the JSON could not parse' }],
  })
  assert.equal(classifyInfraFailure(result), 'worker')
})

test('summary 自己说明 JSON 缺失时归为 json', () => {
  assert.equal(
    classifyInfraFailure(worker({ summary: 'Response did not contain a JSON object' })),
    'json',
  )
})

test('预算耗尽归为 budget（供重试分流不做同预算复跑）', () => {
  assert.equal(
    classifyInfraFailure(worker({ summary: 'max-turns: exhausted without a final turn.' })),
    'budget',
  )
})

test('超时归为 timeout，跳过归为 skip，无特征归为 worker', () => {
  assert.equal(classifyInfraFailure(worker({ summary: 'review timed out after 420s' })), 'timeout')
  assert.equal(classifyInfraFailure(worker({ summary: 'review skipped: no changed files' })), 'skip')
  assert.equal(classifyInfraFailure(worker({ summary: 'something else entirely' })), 'worker')
})
