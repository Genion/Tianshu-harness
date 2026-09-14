/**
 * 进程级「失效提示」总线（2026-09-13 桌面性能阶段 4）。
 *
 * 目的：让桌面端不再按固定节律轮询 `/sessions`（2s）、`/tasks`（5s）——sidecar
 * 侧在会话记录 / 任务状态真正变化时推一条**无载荷的提示**，客户端收到后
 * `invalidateQueries` 重取一次。事件刻意做成幂等、无游标：
 *   - 提示丢了也不会错——客户端保留一条慢速兜底轮询，重连后全量重取一次；
 *   - 不携带记录本体——列表的真源仍是 REST 路由，避免两条通道各自演化出
 *     两套序列化。
 *
 * 合并：同类提示在 `coalesceMs` 窗口内只发一次（trailing）。一段 run 里
 * `persistRecord` / `recountApprovals` 可能每秒触发多次，合并后客户端每窗口
 * 至多重取一次。`count` 记录本窗口合并了多少次 publish，`reason` 取最后一次
 * ——只作观测，不承载语义。
 */

export type ServerEventKind = 'sessions_changed' | 'tasks_changed'

export interface ServerBusEvent {
  kind: ServerEventKind
  /** 发出时刻（合并窗口结束时）。 */
  ts: number
  /** 本窗口内合并的 publish 次数。 */
  count: number
  /** 最后一次 publish 给出的原因（`record` / `delete` / `created`…），仅观测。 */
  reason?: string
}

export type ServerBusListener = (event: ServerBusEvent) => void

export interface ServerEventBusTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface ServerEventBusOptions {
  /** 同类提示的合并窗口（ms）。默认 150。0 = 同步直发（测试用）。 */
  coalesceMs?: number
  timers?: ServerEventBusTimers
  now?: () => number
}

const DEFAULT_COALESCE_MS = 150

const realTimers: ServerEventBusTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

interface PendingWindow {
  handle: unknown
  count: number
  reason?: string
}

export class ServerEventBus {
  private readonly listeners = new Set<ServerBusListener>()
  private readonly pending = new Map<ServerEventKind, PendingWindow>()
  private readonly coalesceMs: number
  private readonly timers: ServerEventBusTimers
  private readonly now: () => number
  private closed = false
  private published = 0
  private emitted = 0

  constructor(opts: ServerEventBusOptions = {}) {
    this.coalesceMs = Math.max(0, opts.coalesceMs ?? DEFAULT_COALESCE_MS)
    this.timers = opts.timers ?? realTimers
    this.now = opts.now ?? Date.now
  }

  /** 发布一条提示。无订阅者时不建定时器（零成本）。 */
  publish(kind: ServerEventKind, reason?: string): void {
    if (this.closed) return
    this.published++
    if (this.listeners.size === 0) return
    const open = this.pending.get(kind)
    if (open) {
      open.count++
      if (reason !== undefined) open.reason = reason
      return
    }
    if (this.coalesceMs === 0) {
      this.emit({ kind, ts: this.now(), count: 1, ...(reason !== undefined ? { reason } : {}) })
      return
    }
    const window: PendingWindow = { handle: undefined, count: 1, ...(reason !== undefined ? { reason } : {}) }
    window.handle = this.timers.setTimeout(() => {
      this.pending.delete(kind)
      this.emit({ kind, ts: this.now(), count: window.count, ...(window.reason !== undefined ? { reason: window.reason } : {}) })
    }, this.coalesceMs)
    this.pending.set(kind, window)
  }

  subscribe(listener: ServerBusListener): () => void {
    if (this.closed) return () => {}
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  listenerCount(): number {
    return this.listeners.size
  }

  /** 观测：累计 publish / 实际发出的次数（合并率 = 1 - emitted/published）。 */
  stats(): { published: number; emitted: number; listeners: number; pending: number } {
    return { published: this.published, emitted: this.emitted, listeners: this.listeners.size, pending: this.pending.size }
  }

  /** 关闭：清掉合并窗口、丢弃订阅者。之后 publish / subscribe 均为空操作。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const window of this.pending.values()) this.timers.clearTimeout(window.handle)
    this.pending.clear()
    this.listeners.clear()
  }

  private emit(event: ServerBusEvent): void {
    this.emitted++
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // 一个坏掉的订阅者（半死的 SSE）不能拖累其他订阅者
      }
    }
  }
}
