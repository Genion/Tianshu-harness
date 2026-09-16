/**
 * 路由鉴权包装与协议头 —— 原先在 session-routes 内联，现按接缝外提供
 * session-routes / workspace-route / scratch-cleanup / storage-cleanup 共用。
 *
 * 语义（逐字节沿用 session-routes 的原实现，勿"顺手优化"）：
 *   - 未授权 → 401 + 协议头（fail-closed）；
 *   - 已授权 → 结果统一戳上协议头，`handled:true`（SSE 自己接管响应）原样放行；
 *   - 结果自带的 headers 优先于协议头默认值。
 *
 * ⚠ 仓内另有一份 withAuth 在 `src/server/routes.ts`（account-routes 与 createRoutes
 * 复用）——它**不**戳协议头，是有意的差异，别合并。认证规则因此有两个载体：
 * 改动 isAuthorizedRequest 的用法时两处都要看，漏一处就是安全洞。
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { TIANSHU_PROTOCOL_HEADER, TIANSHU_PROTOCOL_VERSION } from './delegation-protocol.js'

export const PROTOCOL_HEADERS: Record<string, string> = {
  [TIANSHU_PROTOCOL_HEADER]: String(TIANSHU_PROTOCOL_VERSION),
}

export function withAuth(handler: RouteHandler, apiToken?: string): RouteHandler {
  return async (body, params, headers, res) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) {
      return { status: 401, body: { error: 'Unauthorized' }, headers: PROTOCOL_HEADERS }
    }
    const result = await handler(body, params, headers, res)
    // handled:true (SSE) sets its own headers; still stamp protocol on REST.
    if (result.handled) return result
    return { ...result, headers: { ...PROTOCOL_HEADERS, ...result.headers } }
  }
}
