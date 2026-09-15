/**
 * /config/zen — 禅模式（读专注开局）开关路由。
 * All routes are Bearer-gated (fail-closed), mirroring buildConfigRoutes.
 *
 *   GET /config/zen   读开关现状（未配置 → enabled:false）
 *   PUT /config/zen   用户显式开启/关闭（{ enabled: boolean }）
 *
 * 子模块化原因：config-routes.ts 是点名巨石（source-budgets ceiling，零缓冲），
 * 多 key 池当初也是按同一接缝外提成 config-routes-keys.ts 再 spread 接入。
 * 本模块只依赖 auth.js 与 config/zen-config.js，不进 config-routes 的 import 面。
 *
 * 语义提醒：写入后**新会话生效**——工具面在会话启动期冻结，会话中途换工具集会
 * 改工具指纹、全量重建前缀缓存。路由不做即时相位切换，UI 文案也不许这么许诺。
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import { getZenConfig, setZenConfig } from '../config/zen-config.js'

function withAuth(handler: RouteHandler, apiToken?: string): RouteHandler {
  return async (body, params, headers, res) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }
    return handler(body, params, headers, res)
  }
}

export function buildZenRoutes(apiToken?: string): Record<string, RouteHandler> {
  return {
    'GET /config/zen': withAuth(() => {
      return { status: 200, body: getZenConfig() }
    }, apiToken),

    'PUT /config/zen': withAuth((body) => {
      const { enabled } = (body ?? {}) as { enabled?: unknown }
      if (enabled === undefined) {
        return { status: 400, body: { error: 'enabled is required' } }
      }
      try {
        return { status: 200, body: { ok: true, ...setZenConfig({ enabled }) } }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),
  }
}
