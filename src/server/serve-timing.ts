/**
 * sidecar 启动阶段计时 + listen 后延迟预热（桌面性能阶段 3，2026-09-13）。
 *
 * 背景：sidecar 就绪后的第一秒里所有路由 500–800ms——`loadServeAgent()`（agent 装配
 * chunk 的动态 import）与 `warmPluginToolsCache()`（createDefaultToolRegistry +
 * initializePlugins）在 listen 前后立刻点火，与桌面首批 UI 请求抢同一条主线程。
 * 两件预热都不是首屏必需：首个会话的 createAgent 仍会 `await loadServeAgent()` 即时
 * 触发；插件快照未就绪的早期会话按无插件装配（既有语义），createAgent 侧再做有界等待。
 *
 * 阶段计时默认开（`console.error` → 进 `sidecar-*.log`），一行一阶段：
 *   `[serve-timing] phase=<name> +<ms since runServe start>[ <extra>]`
 * 便于用日志直接读出启动时间线，不必开 RIVET_DEBUG_*。
 */

export const SERVE_TIMING_PREFIX = '[serve-timing]'

/** listen 后到预热点火的默认延迟。首批 UI 请求（/health、/sessions、/config/*）在此窗口内完成。 */
export const DEFAULT_SERVE_WARM_DELAY_MS = 2000

/**
 * createAgent 等插件快照落定的上限：agent chunk import 本身要几百 ms，插件扫描
 * 通常在其内完成；超窗按既有语义无插件装配，一个卡住的插件 import 不能拖死会话创建。
 */
export const PLUGIN_WARM_WAIT_CAP_MS = 1500

/**
 * 阶段计时是否开启：
 * - `RIVET_SERVE_TIMING=0` → 关；
 * - `RIVET_SERVE_TIMING=1` → 开（含 ephemeral / 测试进程，并让 session-routes 的
 *   回放计时等冗长行一并打出）；
 * - 未设 → 生产（非 ephemeral）默认开，ephemeral（测试注入）默认关，免得每个
 *   spawn runServe 的用例多七行 stderr。
 */
export function isServeTimingEnabled(
  opts: { ephemeral?: boolean },
  raw: string | undefined = process.env.RIVET_SERVE_TIMING,
): boolean {
  if (raw === '0') return false
  if (raw === '1') return true
  return !opts.ephemeral
}

export function formatServeTimingPhase(phase: string, elapsedMs: number, extra?: string): string {
  return `${SERVE_TIMING_PREFIX} phase=${phase} +${Math.round(elapsedMs)}ms${extra ? ` ${extra}` : ''}`
}

export interface ServeTimingLogger {
  readonly enabled: boolean
  /** 打一行阶段标记；关闭时零开销（不求值 extra 之外的东西）。 */
  mark(phase: string, extra?: string): void
  /** 自 logger 创建以来的毫秒数（给需要把耗时塞进 extra 的调用方）。 */
  elapsedMs(): number
}

export function createServeTimingLogger(
  enabled: boolean,
  now: () => number = () => performance.now(),
  sink: (line: string) => void = (line) => console.error(line),
): ServeTimingLogger {
  const t0 = now()
  return {
    enabled,
    mark(phase, extra) {
      if (!enabled) return
      sink(formatServeTimingPhase(phase, now() - t0, extra))
    },
    elapsedMs: () => now() - t0,
  }
}

/** `RIVET_SERVE_WARM_DELAY_MS` 覆盖预热延迟；非法/负数回默认；`0` = listen 后立即。 */
export function resolveServeWarmDelayMs(
  raw: string | undefined = process.env.RIVET_SERVE_WARM_DELAY_MS,
): number {
  if (raw == null || raw.trim() === '') return DEFAULT_SERVE_WARM_DELAY_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_SERVE_WARM_DELAY_MS
}

export interface DeferredWarmup {
  /** 已点火（定时到点或 fireNow）。 */
  fired(): boolean
  /** 立刻点火（幂等）：首个会话进入 createAgent 时调用，不等定时器。 */
  fireNow(): void
  /** 取消尚未点火的定时器（server close）。已点火则 no-op。 */
  cancel(): void
}

export interface DeferredWarmupTimers {
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const realTimers: DeferredWarmupTimers = {
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms)
    // 预热不该拖住进程退出（测试 / 早退场景）。
    if (typeof (h as { unref?: () => void }).unref === 'function') (h as { unref: () => void }).unref()
    return h
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

/**
 * 延迟点火的一次性预热。`run` 至多执行一次；异常不外抛（预热失败不该影响 serve）。
 */
export function scheduleDeferredWarmup(
  run: () => void,
  delayMs: number,
  timers: DeferredWarmupTimers = realTimers,
): DeferredWarmup {
  let fired = false
  let handle: unknown = null
  const fire = () => {
    if (fired) return
    fired = true
    if (handle !== null) {
      timers.clearTimeout(handle)
      handle = null
    }
    try {
      run()
    } catch (err) {
      console.error(`${SERVE_TIMING_PREFIX} deferred warmup failed:`, (err as Error)?.message ?? err)
    }
  }
  handle = timers.setTimeout(fire, delayMs)
  return {
    fired: () => fired,
    fireNow: fire,
    cancel: () => {
      if (fired || handle === null) return
      timers.clearTimeout(handle)
      handle = null
    },
  }
}
