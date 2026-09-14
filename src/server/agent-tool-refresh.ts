/**
 * 影响工具表的配置落盘后，让存活 agent 重算一次工具定义。
 *
 * 场景（issue #8 生图槽）：注册生图 provider 会给模型卡打 `supportsImageGen`，
 * 而 `generate_image` 的 `isEnabled` 也随之从 false 翻成 true——但工具定义是
 * agent 构建时快照给 promptEngine 的，不重算的话**当前会话永远看不到它**，
 * 用户表现为"配置成功但工具不出现"（典型的静默失效）。
 *
 * 与 session-manager 的 `applyGlobalApprovalMode` 同属"配置落盘后对存活 agent
 * 广播"的模式：那里广播的是审批档，这里广播的是"工具表可能变了"这一事实——
 * `AgentLoop.updateTools()` 内部会重新走 `gatedToolDefinitions()`，而它每次都会
 * 重新求值各工具的 `isEnabled`，所以无需重建 agent。
 *
 * 逻辑放在这里而不是 session-manager 内，是因为后者受行数棘轮约束（点名巨石，
 * 只降不升）；那边只留一行转发。
 */

/** 最小结构：只需要能遍历出"带 agent 的会话"。`agent` 用 unknown 接——会话类型是
 *  server 内部实现，为一个遍历函数把它拉进依赖图不划算；真正的形状（有 updateTools
 *  方法）在运行时校验。 */
interface ToolRefreshTarget {
  agent?: unknown
}

/**
 * 对每个已构建的 agent 调一次 `updateTools()`。
 * 尚未构建的 agent 不用管——它们构建时会读到最新配置（与 ensureAgent 的磁盘
 * 新鲜值语义一致）。
 *
 * @returns 实际刷新的会话数（遥测与测试用）
 */
export function refreshAgentTools(sessions: Iterable<ToolRefreshTarget>): number {
  let refreshed = 0
  for (const session of sessions) {
    const agent = session.agent as { updateTools?: () => void } | undefined
    const updateTools = agent?.updateTools
    if (typeof updateTools !== 'function') continue
    try {
      updateTools.call(agent)
      refreshed += 1
    } catch {
      // 单个会话刷新失败不影响其余——工具表刷新是尽力而为，不是事务。
    }
  }
  return refreshed
}
