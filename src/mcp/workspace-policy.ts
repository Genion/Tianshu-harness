/**
 * 子 Agent 工作区判定（issue #147 诉求 2）。
 *
 * 规则（单一来源——桌面端开关、TUI、docs/design/subagent-workspace-policy.md 都引这里）：
 *   1. **优先复用**：模型给了工作区参数就原样透传，天枢绝不改写显式意图；
 *   2. **仅在缺失时补**：reuse-session 注入当前会话 cwd；isolated 注入隔离目录；
 *      no-project 仅对声明支持「省略即无项目模式」的 agent 生效（否则退回复用）；
 *   3. **要创建就明示**：每次干预都在结果尾部留一行 `[workdir: …]`；对方回执里能
 *      读到真实工作区时以回执为准。
 *
 * 边界（写进契约，别让读者以为天枢能保证更多）：天枢只保证**传了什么、显示了什么**；
 * 对方工具里是否真的新建了项目条目，由其适配器决定，天枢不承诺也不猜测。
 */
import { join } from 'node:path'
import { rivetHome } from '../config/paths.js'
import { loadConfig } from '../config/manager.js'
import { sessionScratchRoot } from '../server/workspace.js'
import type { McpServerWorkspaceDeclaration, SubAgentWorkspacePolicy } from './config.js'

export type SubAgentWorkspaceSource = 'untouched' | 'explicit' | 'session' | 'isolated' | 'no-project'

export interface SubAgentWorkspacePlan {
  args: Record<string, unknown>
  source: SubAgentWorkspaceSource
  /** 天枢侧本次生效的工作区路径（untouched / no-project 时 undefined）。 */
  path?: string
}

/** agentArg 取值是否在声明支持无项目模式的名单里。 */
function supportsNoProject(
  args: Record<string, unknown>,
  declaration: McpServerWorkspaceDeclaration,
): boolean {
  if (!declaration.agentArg) return false
  const agent = args[declaration.agentArg]
  if (typeof agent !== 'string') return false
  return (declaration.noProjectAgents ?? []).includes(agent)
}

export function resolveSubAgentWorkspace(input: {
  args: Record<string, unknown>
  declaration?: McpServerWorkspaceDeclaration
  policy: SubAgentWorkspacePolicy
  sessionCwd: string
  /** 隔离根（subAgentScratchRoot()）。 */
  scratchRoot: string
  /** 本会话/本次调用的隔离子目录名。 */
  scratchKey: string
}): SubAgentWorkspacePlan {
  const { args, declaration, policy } = input
  // 未声明工作区参数的 server：天枢完全中立（这是默认面，不是异常面）。
  if (!declaration || policy === 'off') return { args, source: 'untouched' }

  const current = args[declaration.arg]
  const explicit = typeof current === 'string' ? current.trim() : ''
  if (explicit) return { args, source: 'explicit', path: explicit }

  if (policy === 'no-project' && supportsNoProject(args, declaration)) {
    // 参数保持缺失 = 对方在自身 default 工作区执行、不登记项目。
    return { args, source: 'no-project' }
  }

  const isolated = policy === 'isolated'
  const path = isolated
    ? join(input.scratchRoot, input.scratchKey || 'mcp-session')
    : input.sessionCwd
  return {
    args: { ...args, [declaration.arg]: path },
    source: isolated ? 'isolated' : 'session',
    path,
  }
}

/**
 * 从工具结果文本里读对方回执的工作区（meta 块 → pathField）。
 *
 * tianshu-mcp 的块形状已核到源码：`---tianshu-mcp-meta---\n<JSON.stringify(meta,null,2)>\n---tianshu-mcp-meta---`
 * （tianshu-mcp dist/mcp/formatter.js:9）——所以必须按**成对 marker 之间**取体，
 * 不能只取一行。读不到就返回 undefined：宁可只说「我传了什么」，也不猜对方落在哪。
 */
export function readWorkspaceReceipt(
  text: string,
  declaration?: McpServerWorkspaceDeclaration,
): string | undefined {
  if (!declaration?.metaMarker || !declaration.pathField) return undefined
  const marker = declaration.metaMarker
  const at = text.indexOf(marker)
  if (at < 0) return undefined
  const rest = text.slice(at + marker.length)
  const end = rest.indexOf(marker)
  const body = (end >= 0 ? rest.slice(0, end) : rest).trim()
  if (!body) return undefined
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const value = parsed[declaration.pathField]
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * 读全局策略。配置读取失败 → 'off'：**不干预比乱改参数安全**
 * （这也是 fail-closed 的方向选择——坏配置下保持改造前行为）。
 */
export function readSubAgentWorkspacePolicy(): SubAgentWorkspacePolicy {
  try {
    return loadConfig().mcp?.subAgentWorkspace ?? 'reuse-session'
  } catch {
    return 'off'
  }
}

/** 子 Agent 隔离根：<rivetHome>/workspace/mcp（与会话临时目录同一约定）。 */
export function subAgentScratchRoot(): string {
  return join(sessionScratchRoot(rivetHome()), 'mcp')
}

/**
 * 内置声明（无需用户配置即生效，配置可覆盖）：
 *
 * - `projectPath` 是 tianshu-mcp `run_task` / `verify_task` 的工作区参数；
 * - `zcode` 支持省略它进入「无项目模式」（在对方 default 工作区执行、不登记项目）
 *   ——见技能文档 §2.2.1；
 * - meta 块形状与 `boundProjectPath` 字段已核到包源码：tianshu-mcp
 *   `dist/mcp/formatter.js`（`---tianshu-mcp-meta---` 包裹 JSON）与
 *   `dist/tasks/task.d.ts` 的 `boundProjectPath?: string`。
 *   若某版本不给该字段，明示行自动降级为「天枢传入的工作区」，不编造对方落点。
 */
export const BUILTIN_WORKSPACE_DECLARATIONS: Record<string, McpServerWorkspaceDeclaration> = {
  'tianshu-mcp': {
    arg: 'projectPath',
    agentArg: 'agentId',
    noProjectAgents: ['zcode'],
    metaMarker: '---tianshu-mcp-meta---',
    pathField: 'boundProjectPath',
  },
}

/** 配置优先，其次内置表（未声明的 server → undefined = 天枢不干预）。 */
export function workspaceDeclarationFor(
  serverId: string,
  configured?: McpServerWorkspaceDeclaration,
): McpServerWorkspaceDeclaration | undefined {
  return configured ?? BUILTIN_WORKSPACE_DECLARATIONS[serverId]
}
