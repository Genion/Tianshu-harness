/**
 * `POST /storage/cleanup` —— 归档会话文件的手动清理（原本内联在 session-routes）。
 *
 * 外提动因：session-routes 是点名巨石（source-budgets ceiling，零缓冲），临时会话
 * 隔离根的清理路由要挂在同一装配处，先在这里腾出等价行数——与本文件同族的
 * 「存储面」逻辑聚在一起也更好找。
 *
 * 语义与原实现逐条一致（勿"顺手优化"）：
 *   { ids?: string[] }          → 只删这些（必须是归档会话）
 *   { olderThanDays?: number }  → 只保留空闲 ≥ N 天的归档会话
 *   {}                          → 删除全部归档
 * 运行中/活跃会话永不受影响（manager 内部强制）。
 */
import type { RouteHandler } from './index.js'
import { withAuth } from './route-auth.js'

export interface ArchivedPurgeSource {
  purgeArchived(opts: { ids?: string[]; olderThanMs?: number }): {
    deleted: number
    freedBytes: number
    ids: string[]
  }
}

export function buildStorageCleanupHandler(source: ArchivedPurgeSource, apiToken?: string): RouteHandler {
  return withAuth((body) => {
    const data = (body ?? {}) as { ids?: unknown; olderThanDays?: unknown }
    const opts: { ids?: string[]; olderThanMs?: number } = {}
    if (Array.isArray(data.ids)) {
      opts.ids = data.ids.filter((x): x is string => typeof x === 'string')
    }
    if (typeof data.olderThanDays === 'number' && data.olderThanDays >= 0) {
      opts.olderThanMs = data.olderThanDays * 86_400_000
    }
    return { status: 200, body: source.purgeArchived(opts) }
  }, apiToken)
}
