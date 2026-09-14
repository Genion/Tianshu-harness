/**
 * GET /events — 全局推送通道（2026-09-13 桌面性能阶段 4）。
 *
 * 一条长连 SSE，承载三类帧：
 *   - `hello`            建连即发，携带心跳周期，客户端据此设空闲超时；
 *   - `sessions_changed` / `tasks_changed`  来自 ServerEventBus 的失效提示（无载荷，
 *                        客户端 invalidateQueries 重取）；
 *   - `health`           每 `heartbeatMs` 一帧，载荷与 `GET /health`（带 token）逐字段
 *                        相同——既是保活，也让客户端在通道连通时把 /health 轮询降到兜底。
 *
 * 鉴权与会话流一致（Bearer）。老客户端不连此路由，行为不变；/mobile 与远程客户端
 * 同为 HTTP SSE，无需特殊处理。
 */
import type { RouteHandler } from './index.js'
import type { HealthSnapshot } from './health-route.js'
import type { ServerEventBus } from './server-event-bus.js'
import type { SseConnectionRegistry } from './sse-registry.js'
import { SseStream } from './sse-stream.js'
import { isAuthorizedRequest } from './auth.js'
import { allowedCorsOrigin } from './cors.js'

export const SERVER_EVENTS_HEARTBEAT_MS = 5_000

export interface ServerEventsRouteOptions {
  healthSnapshot: HealthSnapshot
  /** 心跳周期（ms）。默认 5000。 */
  heartbeatMs?: number
  now?: () => number
}

export function buildServerEventsRoute(
  bus: ServerEventBus,
  apiToken: string | undefined,
  opts: ServerEventsRouteOptions,
  registry?: SseConnectionRegistry,
): Record<string, RouteHandler> {
  const heartbeatMs = Math.max(250, opts.heartbeatMs ?? SERVER_EVENTS_HEARTBEAT_MS)
  const now = opts.now ?? Date.now
  return {
    'GET /events': (body, _params, headers, res) => {
      if (!isAuthorizedRequest({ body, headers }, apiToken)) {
        return { status: 401, body: { error: 'Unauthorized' } }
      }
      if (!res) return { status: 500, body: { error: 'SSE response stream is unavailable' } }

      let unsubscribe: (() => void) | undefined
      let heartbeat: ReturnType<typeof setInterval> | undefined
      const cleanup = () => {
        if (heartbeat) clearInterval(heartbeat)
        heartbeat = undefined
        unsubscribe?.()
        unsubscribe = undefined
        registry?.unregister(sse)
      }
      const sse = new SseStream(res, cleanup, allowedCorsOrigin(headers ?? {}))
      // 登记进活跃连接集合：关停链 closeAll() 主动发 done 帧 + end（sse-registry.ts）。
      registry?.register(sse)
      sse.send('hello', { kind: 'hello', ts: now(), heartbeatMs })
      sse.send('health', { kind: 'health', ts: now(), data: opts.healthSnapshot() })
      unsubscribe = bus.subscribe((ev) => sse.send(ev.kind, ev))
      heartbeat = setInterval(() => {
        sse.send('health', { kind: 'health', ts: now(), data: opts.healthSnapshot() })
      }, heartbeatMs)
      heartbeat.unref?.()
      res.on('close', () => {
        cleanup()
        sse.close()
      })
      if (sse.isClosed()) cleanup()
      return { status: 200, handled: true }
    },
  }
}
