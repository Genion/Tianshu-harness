/**
 * CVM Observer Shadow —— 闭源影子 critic 的开源侧接线。
 *
 * 开源侧只做三件小事：把认知帧投影成只读视图（toShadowFrameView）、把 critic
 * 的建议落一行台账（createShadowLedger）、在 turn 尾触发一次不阻塞的 tick
 * （createShadowTick）。critic 实现由闭源侧经 proRegistry.registerShadowCritic
 * 注入（src/pro/shadow/），开源构建无 pro 模块时注册表恒空 → 全程 no-op。
 *
 * 硬约束（影子语义，改动前先读）：
 * - **零 prompt 字节**：本模块不 import promptEngine、不碰 request 构造，因此影子
 *   开关不可能改变请求字节。机检方式是 shadow-isolation.test.ts 的源码契约断言
 *   （剥离注释后不得出现 promptEngine / buildOaiRequest 字样）+ 接线点不得 await。
 *   **未做** buildOaiRequest 逐字节比对：本模块连 promptEngine 引用都没有，构造一次
 *   真实请求再比对的前提不成立（比对的对象与本模块无交集）。
 * - **不投递**：建议只进台账，绝不 submit 到 advisory-bus / control-plane。
 * - **fail-safe**：critic 返回 null / 抛错 / 超时都只影响台账一行，绝不向 loop
 *   抛出，也绝不 await 进 turn 主链（单飞 + 硬超时 + 串行写队列）。
 *
 * 台账落 session 目录的 shadow-observer.jsonl（与 frames.jsonl 同族），对账键
 * 是 fp = 帧 inputFingerprint 前 12 位（沿用 cognitive-frame-lite 约定）。
 */

import { join } from 'node:path'
import { getSessionDir } from './session-persist.js'
import type { CognitiveFrame } from './cognitive-frame.js'
import { proRegistry } from '../api/pro-registry.js'
import type { ShadowFrameView, TurnShadowCritic } from '../api/pro-registry.js'

export type { ShadowCriticAdvice, ShadowFrameView, TurnShadowCritic } from '../api/pro-registry.js'

export const SHADOW_LEDGER_FILE = 'shadow-observer.jsonl'
/** 行数上限：影子是 1 行/turn 的遥测，与 frames.jsonl 同量级（约 1KB/行）。 */
export const SHADOW_LEDGER_MAX_LINES = 1_500
const DEFAULT_TIMEOUT_MS = 3_000

/** 帧投影的输入形态：接受 readonly 字面量（测试与调用方常直接传字面量）。 */
export interface ShadowStructureFlowView {
  mode: string
  relaxation: number
  planRecommendation: string
  tddRecommendation: string
  reasons: readonly string[]
}

export interface ShadowConvergenceView {
  level: number
  shouldAbort: boolean
  abortCause?: string | null
}

export type ShadowOutcome = 'ok' | 'timeout' | 'error' | 'skipped_inflight'

export interface ShadowLedgerEntry {
  kind: 'observer-shadow'
  v: 1
  turn: number
  /** 帧指纹前 12 位 —— 与 frames.jsonl 同 turn 记录的对账键。 */
  fp: string
  phaseClass: string
  advice: import('../api/pro-registry.js').ShadowCriticAdvice | null
  outcome: ShadowOutcome
  latencyMs: number
  /** 该帧是否空虚（无实测动量）。台账自带此位，报告侧才能算「空虚违规」
   *  （空虚帧上高置信干预）而不必再 join frames.jsonl。 */
  vacuous?: boolean
  error?: string
}

export interface ShadowLedger {
  readonly enabled: boolean
  write(entry: ShadowLedgerEntry): void
  /** 等在途写入完成并强制收尾 trim（由 pending() 调用；tick 主链不 await 它）。 */
  flush(): Promise<void>
}

const NOOP_LEDGER: ShadowLedger = { enabled: false, write() {}, async flush() {} }

export interface ShadowLedgerOptions {
  cwd: string
  sessionId?: string
  /** 测试注入：行数上限。 */
  maxLines?: number
}

/**
 * 台账落盘。开关与 frame-telemetry 同族：`RIVET_TELEMETRY_LITE=0` 全关、
 * `RIVET_SHADOW_CRITIC=0` 只关影子。IO 失败吞掉，绝不阻断 loop。
 */
export function createShadowLedger(options: ShadowLedgerOptions): ShadowLedger {
  if (process.env['RIVET_TELEMETRY_LITE'] === '0') return NOOP_LEDGER
  if (process.env['RIVET_SHADOW_CRITIC'] === '0') return NOOP_LEDGER

  const maxLines = options.maxLines ?? SHADOW_LEDGER_MAX_LINES
  /** 触发压缩的水位 = 上限的 1.5 倍。**不能**用 `lineCount > maxLines`：写满后
   *  lineCount 恒大于上限，会退化成每写一行全量 read+rewrite 一次（1.5MB/行）。
   *  到水位即压回 maxLines，之后有 maxLines/2 行的写窗口无需再压。 */
  const trimAt = Math.ceil(maxLines * 1.5)
  const dir = options.sessionId
    ? join(getSessionDir(options.cwd), options.sessionId)
    : join(options.cwd, '.rivet')
  const path = join(dir, SHADOW_LEDGER_FILE)

  let lineCount: number | null = null
  let queue: Promise<void> = Promise.resolve()
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    queue = queue.then(task).catch(() => { /* fail-safe：影子遥测绝不阻断 loop */ })
    return queue
  }

  async function trimIfNeeded(fs: typeof import('node:fs/promises')): Promise<void> {
    try {
      const raw = await fs.readFile(path, 'utf-8')
      const lines = raw.split('\n').filter(l => l.length > 0)
      if (lines.length > trimAt) {
        const tail = lines.slice(lines.length - maxLines)
        await fs.writeFile(path, tail.join('\n') + '\n', 'utf-8')
        lineCount = tail.length
      } else {
        lineCount = lines.length
      }
    } catch { /* 文件不存在/读失败 → 无事可做 */ }
  }

  return {
    enabled: true,
    write(entry: ShadowLedgerEntry) {
      const line = JSON.stringify(entry)
      enqueue(async () => {
        const fs = await import('node:fs/promises')
        await fs.mkdir(dir, { recursive: true })
        if (lineCount === null) {
          try {
            const raw = await fs.readFile(path, 'utf-8')
            lineCount = raw.split('\n').filter(l => l.length > 0).length
          } catch {
            lineCount = 0
          }
        }
        await fs.appendFile(path, line + '\n', 'utf-8')
        lineCount++
        if (lineCount > trimAt) await trimIfNeeded(fs)
      })
    },
    async flush() {
      await enqueue(async () => {
        if (lineCount === null) return
        const fs = await import('node:fs/promises')
        await trimIfNeeded(fs)
      })
    },
  }
}

/**
 * 帧 → 只读视图。纯函数：字段挑选 + 浅拷贝，无 IO、无时钟、不碰 prompt。
 * 缺失源保持 null（**不得填默认值**——在假数据上产生的建议会污染台账）。
 */
export function toShadowFrameView(
  frame: CognitiveFrame,
  structureFlow: ShadowStructureFlowView | null,
  convergence: ShadowConvergenceView | null,
): ShadowFrameView {
  return {
    turn: frame.turn,
    phaseClass: frame.phaseClass,
    inputFingerprint: frame.inputFingerprint,
    quality: { ...frame.quality },
    sensorium: frame.facts.sensorium ? { ...frame.facts.sensorium } : null,
    pal: frame.facts.pal ? { ...frame.facts.pal } : null,
    evidence: { ...frame.facts.evidence },
    user: { ...frame.facts.user },
    plan: { ...frame.facts.plan },
    progress: { ...frame.facts.progress },
    structureFlow: structureFlow
      ? {
        mode: structureFlow.mode,
        relaxation: structureFlow.relaxation,
        planRecommendation: structureFlow.planRecommendation,
        tddRecommendation: structureFlow.tddRecommendation,
        reasons: [...structureFlow.reasons],
      }
      : null,
    convergence: convergence
      ? {
        level: convergence.level,
        shouldAbort: convergence.shouldAbort,
        abortCause: convergence.abortCause ?? null,
      }
      : null,
  }
}

export interface ShadowTickInput {
  frame: CognitiveFrame
  structureFlow: ShadowStructureFlowView | null
  convergence: ShadowConvergenceView | null
}

export interface ShadowTickDeps {
  cwd: string
  sessionId?: string
  /** critic 来源。缺省 → 从 proRegistry 取 factory 并惰性创建一次。 */
  getCritic?: () => TurnShadowCritic | undefined
  /** 台账。缺省 → createShadowLedger(deps)。 */
  ledger?: ShadowLedger
  /** 单次 critic 硬超时（默认 3000ms）。 */
  timeoutMs?: number
}

export interface ShadowTick {
  /** 触发一次影子 tick：不阻塞、不抛出、同一时刻只允许一个在途。 */
  tick(input: ShadowTickInput): void
  /** 等当前在途 tick 与台账写队列全部收尾（收尾必须调它，否则可能丢行）。 */
  pending(): Promise<void>
  /** 收尾：释放 critic（常驻子进程随 critic.dispose 一起回收，不再重拉）。 */
  dispose(): void
}

export function createShadowTick(deps: ShadowTickDeps): ShadowTick {
  const ledger = deps.ledger ?? createShadowLedger(deps)
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  let criticResolved = false
  let cachedCritic: TurnShadowCritic | undefined
  const resolveCritic = (): TurnShadowCritic | undefined => {
    if (deps.getCritic) return deps.getCritic()
    if (criticResolved) return cachedCritic
    const factory = proRegistry.getShadowCriticFactory()
    // 未注册（如 pro 模块尚未加载）时不置位——下次 tick 再试。
    if (!factory) return undefined
    try {
      cachedCritic = factory({ cwd: deps.cwd, sessionId: deps.sessionId })
    } catch {
      cachedCritic = undefined
    }
    criticResolved = true
    return cachedCritic
  }

  let inFlight = false
  let queue: Promise<void> = Promise.resolve()

  function tick(input: ShadowTickInput): void {
    if (!ledger.enabled) return
    if (inFlight) {
      // 丢 tick 必须留痕：模型 critic 单次可能耗时数百 ms，密集工具轮下丢 tick 是常态。
      // 不记账就无法区分「影子没跑」与「影子跑了但没给建议」——前者是覆盖率问题，
      // 后者是判断力问题，两者在 §7 指标里必须分列。
      const dropped = toShadowFrameView(input.frame, input.structureFlow, input.convergence)
      ledger.write({
        kind: 'observer-shadow',
        v: 1,
        turn: dropped.turn,
        fp: dropped.inputFingerprint.slice(0, 12),
        phaseClass: dropped.phaseClass,
        advice: null,
        outcome: 'skipped_inflight',
        latencyMs: 0,
        vacuous: !dropped.sensorium || dropped.sensorium.momentumHasData === false,
      })
      return
    }
    const critic = resolveCritic()
    if (!critic) return

    inFlight = true
    const startedAt = Date.now()
    const view = toShadowFrameView(input.frame, input.structureFlow, input.convergence)
    // 预算：critic 可声明自身耗时量级（真实模型加载是秒级），优先于 tick 默认值——
    // 否则 tick 先超时、台账记 timeout，而宿主其实仍在正常推理。
    const budgetMs = critic.timeoutMs ?? timeoutMs
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const work = Promise.resolve().then(() => critic(view))
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        reject(new Error(`shadow critic timed out after ${budgetMs}ms`))
      }, budgetMs)
    })

    queue = queue.then(async () => {
      let advice: import('../api/pro-registry.js').ShadowCriticAdvice | null = null
      let outcome: ShadowOutcome = 'ok'
      let error: string | undefined
      try {
        advice = await Promise.race([work, timeout])
      } catch (e) {
        outcome = timedOut ? 'timeout' : 'error'
        error = e instanceof Error ? e.message : String(e)
        // 迟到收尾：race 结束后 work 仍可能 reject（unhandledRejection 会崩进程）。
        void work.catch(() => { /* 影子无副作用，迟到失败无需上报 */ })
      } finally {
        if (timer) clearTimeout(timer)
        inFlight = false
        ledger.write({
          kind: 'observer-shadow',
          v: 1,
          turn: view.turn,
          fp: view.inputFingerprint.slice(0, 12),
          phaseClass: view.phaseClass,
          advice,
          outcome,
          latencyMs: Date.now() - startedAt,
          vacuous: !view.sensorium || view.sensorium.momentumHasData === false,
          ...(error ? { error } : {}),
        })
      }
    })
  }

  async function pending(): Promise<void> {
    await queue
    // 台账写是「同步投递、异步落盘」：tick.queue 完成只保证 ledger.write 被调用，
    // 不保证行已落盘。收尾入口（loop-factory 组合 flush）只调 pending——
    // 因此这里必须排空台账队列，否则进程退出窗口会丢会话末尾的台账行。
    await ledger.flush()
  }

  function dispose(): void {
    try {
      cachedCritic?.dispose?.()
    } catch { /* 收尾失败不得阻断退出 */ }
    cachedCritic = undefined
    criticResolved = true // 阻止收尾后重新拉起（pro 模块仍在注册表里）
  }

  return { tick, pending, dispose }
}
