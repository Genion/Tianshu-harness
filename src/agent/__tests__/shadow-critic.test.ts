import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assembleCognitiveFrame } from '../cognitive-frame.js'
import type { CognitiveFrame } from '../cognitive-frame.js'
import {
  SHADOW_LEDGER_FILE,
  createShadowLedger,
  createShadowTick,
  toShadowFrameView,
} from '../shadow-critic.js'
import type { ShadowCriticAdvice, ShadowLedger, ShadowTickInput } from '../shadow-critic.js'

let sessionRoot: string

beforeEach(async () => {
  sessionRoot = await mkdtemp(join(tmpdir(), 'shadow-critic-'))
  process.env['RIVET_SESSION_DIR'] = sessionRoot
})

afterEach(async () => {
  delete process.env['RIVET_SESSION_DIR']
  delete process.env['RIVET_SHADOW_CRITIC']
  await rm(sessionRoot, { recursive: true, force: true })
})

const SESSION_ID = 'sess-1'

function ledgerPath(): string {
  return join(sessionRoot, SESSION_ID, SHADOW_LEDGER_FILE)
}

function makeFrame(over: Partial<Parameters<typeof assembleCognitiveFrame>[0]> = {}): CognitiveFrame {
  return assembleCognitiveFrame({
    turn: 3,
    phaseClass: 'execute',
    efe: { epistemicValue: 0.2, pragmaticValue: 0.3, noveltyBonus: 0.1, precision: 0.8 },
    sensorium: { momentum: 0.7, momentumHasData: true, stability: 0.8 },
    flow: { score: 0.6, sampleCount: 5, requiredSamples: 4 },
    pal: null,
    evidence: { hasVerificationDebt: true, deliveryStatus: 'unverified', consecutiveFailures: 1 },
    user: { intervened: false },
    plan: { activePlanFile: false, planModeState: 'off' },
    progress: { todoCompletedDelta: 1 },
    ...over,
  })
}

const STRUCTURE_FLOW = {
  mode: 'tighten',
  relaxation: 0,
  planRecommendation: 'none',
  tddRecommendation: 'neutral',
  reasons: ['verification-debt'],
} as const

const CONVERGENCE = { level: 1, shouldAbort: false, abortCause: null } as const

function tickInput(frame: CognitiveFrame): ShadowTickInput {
  return { frame, structureFlow: STRUCTURE_FLOW, convergence: CONVERGENCE }
}

async function readLedgerLines(): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(ledgerPath(), 'utf-8')
  return raw.split('\n').filter(l => l.length > 0).map(l => JSON.parse(l) as Record<string, unknown>)
}

describe('shadow-critic · 视图构造', () => {
  it('取帧字段与质量标注，缺失源保持 null（不伪造默认值）', () => {
    const withData = toShadowFrameView(makeFrame(), STRUCTURE_FLOW, CONVERGENCE)
    assert.equal(withData.turn, 3)
    assert.equal(withData.phaseClass, 'execute')
    assert.deepEqual(withData.sensorium, { momentum: 0.7, momentumHasData: true, stability: 0.8 })
    assert.equal(withData.quality['sensorium'], 'measured')
    assert.equal(withData.evidence.hasVerificationDebt, true)
    assert.equal(withData.structureFlow?.mode, 'tighten')
    assert.equal(withData.convergence?.level, 1)

    const withoutSensorium = toShadowFrameView(makeFrame({ sensorium: null }), null, null)
    assert.equal(withoutSensorium.sensorium, null, '缺源必须是 null，不得填默认值')
    assert.equal(withoutSensorium.quality['sensorium'], 'missing')
    assert.equal(withoutSensorium.structureFlow, null)
    assert.equal(withoutSensorium.convergence, null)
  })

  it('inputFingerprint 与帧一致（台账对账键）', () => {
    const frame = makeFrame()
    const view = toShadowFrameView(frame, STRUCTURE_FLOW, CONVERGENCE)
    assert.equal(view.inputFingerprint, frame.inputFingerprint)
  })
})

describe('shadow-critic · 台账落盘', () => {
  it('追加一行 JSONL，fp 为帧指纹前 12 位', async () => {
    const frame = makeFrame()
    const ledger = createShadowLedger({ cwd: sessionRoot, sessionId: SESSION_ID })
    assert.equal(ledger.enabled, true)
    ledger.write({
      kind: 'observer-shadow',
      v: 1,
      turn: frame.turn,
      fp: frame.inputFingerprint.slice(0, 12),
      phaseClass: frame.phaseClass,
      advice: { action: 'verify_first', confidence: 0.7, reason: '验证债' },
      outcome: 'ok',
      latencyMs: 12,
    })
    await ledger.flush()
    const lines = await readLedgerLines()
    assert.equal(lines.length, 1)
    assert.equal(lines[0]!['kind'], 'observer-shadow')
    assert.equal(lines[0]!['fp'], frame.inputFingerprint.slice(0, 12))
    assert.deepEqual(lines[0]!['advice'], { action: 'verify_first', confidence: 0.7, reason: '验证债' })
  })

  it('并发 10 次写作不丢行、每行可解析', async () => {
    const ledger = createShadowLedger({ cwd: sessionRoot, sessionId: SESSION_ID })
    for (let i = 0; i < 10; i++) {
      ledger.write({
        kind: 'observer-shadow', v: 1, turn: i, fp: `fp${i}`,
        phaseClass: 'execute', advice: null, outcome: 'ok', latencyMs: i,
      })
    }
    await ledger.flush()
    const lines = await readLedgerLines()
    assert.equal(lines.length, 10)
    assert.deepEqual(lines.map(l => l['turn']), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('RIVET_SHADOW_CRITIC=0 时禁用且不建文件', async () => {
    process.env['RIVET_SHADOW_CRITIC'] = '0'
    const ledger = createShadowLedger({ cwd: sessionRoot, sessionId: SESSION_ID })
    assert.equal(ledger.enabled, false)
    ledger.write({
      kind: 'observer-shadow', v: 1, turn: 1, fp: 'fp', phaseClass: 'execute',
      advice: null, outcome: 'ok', latencyMs: 1,
    })
    await ledger.flush()
    assert.equal(existsSync(ledgerPath()), false, '禁用时不得落盘')
  })
})

describe('shadow-critic · tick 生命周期', () => {
  it('pending() 覆盖台账写队列：收尾等在途写入完成（不得依赖调用方补 flush）', async () => {
    // 契约锚点：ledger.write 是「同步投递到台账私有队列后立即返回」，
    // 因此 tick.queue 完成 ≠ 台账行已落盘。pending() 是收尾的唯一入口
    // （loop-factory 组合 flush 只调 pending），它必须自行覆盖台账队列——
    // 否则进程退出窗口内丢掉会话末尾若干行判据分母。
    const calls: string[] = []
    const ledger: ShadowLedger = {
      enabled: true,
      write() { calls.push('write') },
      async flush() { calls.push('flush') },
    }
    const tick = createShadowTick({
      cwd: sessionRoot, sessionId: SESSION_ID, ledger,
      getCritic: () => async () => ({ action: 'no_action', confidence: 0.5, reason: 'ok' }),
    })
    tick.tick(tickInput(makeFrame()))
    await tick.pending()
    assert.deepEqual(calls, ['write', 'flush'], 'pending() 返回时台账必须已排空（write → flush）')
  })

  it('无 critic 时零成本：不落任何行', async () => {
    const ledger = createShadowLedger({ cwd: sessionRoot, sessionId: SESSION_ID })
    const tick = createShadowTick({ cwd: sessionRoot, sessionId: SESSION_ID, ledger, getCritic: () => undefined })
    tick.tick(tickInput(makeFrame()))
    await tick.pending()
    await ledger.flush()
    assert.equal(existsSync(ledgerPath()), false, '没有 critic 就不该有台账行')
  })

  it('critic 返回建议时落 ok 行，含 advice 与 latencyMs', async () => {
    const advice: ShadowCriticAdvice = { action: 'verify_first', confidence: 0.7, reason: '验证债高' }
    const ledger = createShadowLedger({ cwd: sessionRoot, sessionId: SESSION_ID })
    const tick = createShadowTick({
      cwd: sessionRoot, sessionId: SESSION_ID, ledger,
      getCritic: () => async () => advice,
    })
    tick.tick(tickInput(makeFrame()))
    await tick.pending()
    await ledger.flush()
    const lines = await readLedgerLines()
    assert.equal(lines.length, 1)
    assert.equal(lines[0]!['outcome'], 'ok')
    assert.deepEqual(lines[0]!['advice'], advice)
    assert.equal(typeof lines[0]!['latencyMs'], 'number')
    assert.equal(lines[0]!['turn'], 3)
  })

  it('critic 抛错落 error 行且不向 loop 抛出', async () => {
    const ledger = createShadowLedger({ cwd: sessionRoot, sessionId: SESSION_ID })
    const tick = createShadowTick({
      cwd: sessionRoot, sessionId: SESSION_ID, ledger,
      getCritic: () => async () => { throw new Error('boom') },
    })
    tick.tick(tickInput(makeFrame()))
    await tick.pending()
    await ledger.flush()
    const lines = await readLedgerLines()
    assert.equal(lines.length, 1)
    assert.equal(lines[0]!['outcome'], 'error')
    assert.match(String(lines[0]!['error']), /boom/)
    assert.equal(lines[0]!['advice'], null)
  })

  it('critic 超时落 timeout 行（不挂住 loop）', async () => {
    const ledger = createShadowLedger({ cwd: sessionRoot, sessionId: SESSION_ID })
    const tick = createShadowTick({
      cwd: sessionRoot, sessionId: SESSION_ID, ledger, timeoutMs: 20,
      getCritic: () => () => new Promise<ShadowCriticAdvice | null>(() => { /* never resolves */ }),
    })
    tick.tick(tickInput(makeFrame()))
    await tick.pending()
    await ledger.flush()
    const lines = await readLedgerLines()
    assert.equal(lines.length, 1)
    assert.equal(lines[0]!['outcome'], 'timeout')
  })

  it('单飞：in-flight 期间第二次 tick 不调用 critic，但落 skipped_inflight 行留痕', async () => {
    let calls = 0
    const ledger = createShadowLedger({ cwd: sessionRoot, sessionId: SESSION_ID })
    const tick = createShadowTick({
      cwd: sessionRoot, sessionId: SESSION_ID, ledger,
      getCritic: () => async () => {
        calls++
        await new Promise(r => setTimeout(r, 30))
        return null
      },
    })
    tick.tick(tickInput(makeFrame()))
    tick.tick(tickInput(makeFrame()))
    await tick.pending()
    await ledger.flush()
    const lines = await readLedgerLines()
    assert.equal(calls, 1, '同一时刻只允许一个 in-flight critic 调用')
    assert.equal(lines.length, 2, '被丢的 tick 必须留痕——否则分不清「影子没跑」与「跑了没建议」')
    assert.equal(lines.filter(l => l['outcome'] === 'skipped_inflight').length, 1)
    assert.equal(lines.filter(l => l['outcome'] === 'ok').length, 1)
  })

  it('critic 返回 null 时仍落行（outcome=ok, advice=null），保持分母完整', async () => {
    const ledger = createShadowLedger({ cwd: sessionRoot, sessionId: SESSION_ID })
    const tick = createShadowTick({
      cwd: sessionRoot, sessionId: SESSION_ID, ledger, getCritic: () => async () => null,
    })
    tick.tick(tickInput(makeFrame()))
    await tick.pending()
    await ledger.flush()
    const lines = await readLedgerLines()
    assert.equal(lines.length, 1)
    assert.equal(lines[0]!['outcome'], 'ok')
    assert.equal(lines[0]!['advice'], null)
  })
})

describe('shadow-critic · critic 预算声明（审查 HIGH 2 回归）', () => {
  it('critic 声明的 timeoutMs 优先于 tick 默认值，真实模型加载不被误杀', async () => {
    const ledger = createShadowLedger({ cwd: sessionRoot, sessionId: SESSION_ID })
    const slowCritic = Object.assign(
      async () => {
        await new Promise(r => setTimeout(r, 120))
        return { action: 'no_action' as const, confidence: 0.5, reason: 'slow-ok' }
      },
      { timeoutMs: 1_000 },
    )
    const tick = createShadowTick({
      cwd: sessionRoot, sessionId: SESSION_ID, ledger, timeoutMs: 30, getCritic: () => slowCritic,
    })
    tick.tick(tickInput(makeFrame()))
    await tick.pending()
    await ledger.flush()
    const lines = await readLedgerLines()
    assert.equal(
      lines[0]!['outcome'], 'ok',
      'critic 声明 1000ms，不该被 tick 的 30ms 默认值判成 timeout（否则台账误报失败）',
    )
    assert.deepEqual(lines[0]!['advice'], { action: 'no_action', confidence: 0.5, reason: 'slow-ok' })
  })

  it('critic 未声明预算时仍受 tick 默认值约束（防呆保留）', async () => {
    const ledger = createShadowLedger({ cwd: sessionRoot, sessionId: SESSION_ID })
    const tick = createShadowTick({
      cwd: sessionRoot, sessionId: SESSION_ID, ledger, timeoutMs: 30,
      getCritic: () => async () => {
        await new Promise(r => setTimeout(r, 200))
        return null
      },
    })
    tick.tick(tickInput(makeFrame()))
    await tick.pending()
    await ledger.flush()
    const lines = await readLedgerLines()
    assert.equal(lines[0]!['outcome'], 'timeout')
  })
})
