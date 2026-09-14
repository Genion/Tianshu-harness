import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromptEngine } from '../engine.js'
import { summarizeAppendixParts } from '../appendix-anatomy.js'
import type { AppendixPart } from '../volatile.js'
import type { OaiMessage } from '../../api/oai-types.js'

/**
 * appendix 构成分解 —— 把 cache-log 的 `appendixChars`（单一总量）拆成
 * 「CVM 计量块」与「keep-list」两笔账，让 zenLean 的裁剪量变成可观测数字。
 *
 * 背景（2026-09-13 zen 缓存调研）：会话 ada47b87 的 appendixChars 在 zen 相位
 * 恒为 6759、full 相位恒为 7844，差值 1085 字符一度被读成「zenLean 没生效」。
 * 真因有两个：appendix 只在用户边界重建（工具轮复用缓存），以及总量口径看不见
 * 构成。这里的断言锁住那个差值本身 —— cvmChars，即 zenLean 能省下的上限。
 *
 * 独立佐证（历史 telemetry，非本测试）：同一会话 sensorium.jsonl 的 cvmBySource
 * 在 zen 相位零增长，跨到 full 边界轮才出现 projection:123 + tool-context:43 +
 * advisory-appendix:120 = 286 token ≈ 1144 字符 —— 与本测试测的 cvmChars 同量纲。
 */

const CONTEXT_WINDOW = 200_000

function createEngine(): PromptEngine {
  return new PromptEngine({
    model: 'test-model',
    maxTokens: 4096,
    appendixDelta: true,
    staticCtx: { tools: [] },
    volatileCtx: {
      cwd: '/test/project',
      gitStatus: 'Current branch: main\nStatus:\nM src/foo.ts',
      rivetMd: '# Test Project',
    },
  })
}

function userTurn(text: string): OaiMessage[] {
  return [{ role: 'user', content: text }]
}

describe('summarizeAppendixParts — appendix 构成分解', () => {
  it('把 CVM 计量块与 keep-list 块分成两笔账', () => {
    const projection = '<cognitive-mirror>steady state</cognitive-mirror>'
    const gitStatus = '<git-status>\nM src/foo.ts\n</git-status>'
    const parts: AppendixPart[] = [
      { name: 'cognitive-mirror', content: projection, source: 'projection' },
      { name: 'git-status', content: gitStatus },
    ]

    const anatomy = summarizeAppendixParts(parts)

    assert.equal(anatomy.blocks, 2)
    assert.equal(anatomy.cvmChars, projection.length)
    assert.equal(anatomy.keepChars, gitStatus.length)
    assert.equal(anatomy.partsChars, projection.length + gitStatus.length)
    assert.deepEqual(anatomy.cvmBySource, { projection: projection.length })
  })

  it('同一 source 的多个块累加，不同 source 分开记', () => {
    const a = '<cognitive-mirror>a</cognitive-mirror>'
    const b = '<cognitive-mirror>b</cognitive-mirror>'
    const c = '<tool-context>read, grep</tool-context>'
    const parts: AppendixPart[] = [
      { name: 'cognitive-mirror', content: a, source: 'projection' },
      { name: 'cognitive-mirror-b', content: b, source: 'projection' },
      { name: 'tool-context', content: c, source: 'tool-context' },
    ]

    const anatomy = summarizeAppendixParts(parts)

    assert.equal(anatomy.cvmChars, a.length + b.length + c.length)
    assert.deepEqual(anatomy.cvmBySource, { projection: a.length + b.length, 'tool-context': c.length })
  })

  it('空 appendix → 全零（而不是抛错或 undefined）', () => {
    const anatomy = summarizeAppendixParts([])
    assert.deepEqual(anatomy, { blocks: 0, partsChars: 0, cvmChars: 0, keepChars: 0, cvmBySource: {} })
  })
})

describe('engine.getAppendixAnatomy — 与构建同步的构成快照', () => {
  it('未构建过时为 null（没有 appendix 就没有构成）', () => {
    const engine = createEngine()
    assert.equal(engine.getAppendixAnatomy(), null)
  })

  it('边界构建后：cvmChars 与 drainAppendixLedger 记的 CVM 字节同量', () => {
    const engine = createEngine()
    const projection = '<cognitive-mirror>steady state</cognitive-mirror>'
    engine.setCognitiveProjection(projection)

    engine.buildOaiRequest(userTurn('first'), undefined, CONTEXT_WINDOW)

    const anatomy = engine.getAppendixAnatomy()
    assert.ok(anatomy, '主路径边界构建后必须有构成快照')
    assert.equal(anatomy.cvmChars, projection.length)

    // 首次边界是 sendFull：账本记全部 CVM 块，故与 anatomy 的 CVM 总量一致。
    const rows = engine.drainAppendixLedger()
    const charged = rows.find(r => r.source === 'projection')?.chars ?? 0
    assert.equal(charged, anatomy.cvmChars, '同一轮的两个口径（收费账 vs 构成账）必须对齐')
  })

  it('工具轮复用缓存：构成快照随 cachedAppendix 一起冻结', () => {
    const engine = createEngine()
    engine.setCognitiveProjection('<cognitive-mirror>v1</cognitive-mirror>')
    const messages = userTurn('do the thing')

    engine.buildOaiRequest(messages, undefined, CONTEXT_WINDOW)
    const first = engine.getAppendixAnatomy()
    engine.drainAppendixLedger()

    for (let i = 0; i < 3; i++) {
      engine.buildOaiRequest(messages, undefined, CONTEXT_WINDOW)
      assert.deepEqual(engine.getAppendixAnatomy(), first, `tool turn ${i} 不应改变构成快照`)
    }
  })

  it('zenLean 生效：CVM 账归零，keep-list 字节一字不动（缓存安全）', () => {
    const engine = createEngine()
    engine.setCognitiveProjection('<cognitive-mirror>' + 'x'.repeat(400) + '</cognitive-mirror>')
    engine.setToolContext('<tool-context>' + 'y'.repeat(200) + '</tool-context>')

    engine.buildOaiRequest(userTurn('full phase'), undefined, CONTEXT_WINDOW)
    const full = engine.getAppendixAnatomy()
    assert.ok(full && full.cvmChars > 0, '前置条件：full 相位必须有 CVM 块')

    engine.setZenLean(true)
    engine.buildOaiRequest(userTurn('zen phase'), undefined, CONTEXT_WINDOW)
    const lean = engine.getAppendixAnatomy()

    assert.ok(lean, 'zen 相位同样要有构成快照')
    assert.equal(lean.cvmChars, 0, 'zenLean 必须把所有 CVM 计量块裁掉')
    assert.deepEqual(lean.cvmBySource, {}, 'zenLean 下不该留下任何 source 账')
    assert.equal(lean.keepChars, full.keepChars, 'keep-list 不受 zenLean 影响 —— 这是它 cache-safe 的根据')
    assert.ok(lean.blocks < full.blocks, '块数应减少')
  })

  it('zenLean 的削减量就是 cvmChars：partsChars 差 == CVM 账差', () => {
    const engine = createEngine()
    engine.setCognitiveProjection('<cognitive-mirror>' + 'x'.repeat(400) + '</cognitive-mirror>')
    engine.setToolContext('<tool-context>' + 'y'.repeat(200) + '</tool-context>')

    engine.buildOaiRequest(userTurn('full phase'), undefined, CONTEXT_WINDOW)
    const full = engine.getAppendixAnatomy()!
    const fullLen = engine.getCachedAppendixLength()

    engine.setZenLean(true)
    engine.buildOaiRequest(userTurn('zen phase'), undefined, CONTEXT_WINDOW)
    const lean = engine.getAppendixAnatomy()!
    const leanLen = engine.getCachedAppendixLength()

    assert.equal(full.partsChars - lean.partsChars, full.cvmChars - lean.cvmChars)

    // 与 cache-log 的 appendixChars 对账：总额的削减 ≥ cvmChars，差额是 join 分隔符
    // （每裁掉一个块少一个 '\n\n'）与块内包装——故这里是下界而非等号。
    assert.ok(
      fullLen - leanLen >= full.cvmChars - lean.cvmChars,
      `appendixChars 削减 ${fullLen - leanLen} 应不小于 cvmChars ${full.cvmChars - lean.cvmChars}`,
    )
  })

  it('历史重写（invalidateFreshCache）后快照与 cachedAppendix 同生命周期地清空', () => {
    const engine = createEngine()
    engine.setCognitiveProjection('<cognitive-mirror>pre-rewrite</cognitive-mirror>')
    engine.buildOaiRequest(userTurn('first'), undefined, CONTEXT_WINDOW)
    assert.ok(engine.getAppendixAnatomy())

    // updateSessionMemory → rebuildFrozenBase + invalidateFreshCache
    engine.updateSessionMemory('<session-memory>rewritten</session-memory>')

    assert.equal(engine.getAppendixAnatomy(), null, '缓存已失效，旧构成快照不能继续冒充当前 appendix')
    assert.equal(engine.getCachedAppendixLength(), 0)
  })
})
