import type { Tool, ToolCallParams, ToolResult } from '../tools/types.js'
import { classifyMcpError } from './failure-classifier.js'
import { evaluateMcpPolicy, type McpCapability } from './policy.js'
import { resolveSubAgentWorkspace, readWorkspaceReceipt } from './workspace-policy.js'
import type { McpServerWorkspaceDeclaration, SubAgentWorkspacePolicy } from './config.js'

export function mcpToolName(serverId: string, toolName: string): string {
  const safeServerId = serverId.replaceAll('__', '_')
  const safeToolName = toolName.replaceAll('__', '_')
  return `mcp__${safeServerId}__${safeToolName}`
}

/**
 * Per-session record of which MCP connectors the user has opted into.
 *
 * Borrowed from the connector opt-in principle: never silently use a connector
 * the user did not choose. The FIRST tool call from a given connector requires
 * approval; once approved (and executed), the connector's read-only tools no
 * longer prompt. Write-capable tools keep their own per-call approval.
 */
export interface McpConnectorConsent {
  hasConsented(serverId: string): boolean
  grantConsent(serverId: string): void
}

export function createMcpConnectorConsent(): McpConnectorConsent {
  const consented = new Set<string>()
  return {
    hasConsented: (serverId: string) => consented.has(serverId),
    grantConsent: (serverId: string) => { consented.add(serverId) },
  }
}

export interface McpToolSecurityPolicy {
  capability?: Exclude<McpCapability, 'unknown'>
  requireApproval?: true
}

interface McpToolDefinition {
  name: string
  description?: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
  }
}

interface McpCallResult {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType?: string }>
  isError?: boolean
}

type CallToolFn = (input: Record<string, unknown>) => Promise<McpCallResult>

/**
 * 子 Agent 工作区处置上下文（issue #147）。缺省不传 = 天枢不干预任何参数
 * （与改造前逐字节一致）；只在 server 声明了 workspace 时由 manager 传入。
 */
export interface McpWorkspaceContext {
  declaration: McpServerWorkspaceDeclaration
  policy: SubAgentWorkspacePolicy
  /** 隔离根（subAgentScratchRoot()）。 */
  scratchRoot: string
}

export function createMcpToolWrapper(
  serverId: string,
  mcpDef: McpToolDefinition,
  callTool: CallToolFn,
  consent?: McpConnectorConsent,
  securityPolicy?: McpToolSecurityPolicy,
  /** 传输类型——供错误归因区分「stdio 子进程退出」与「远程断连」。 */
  transport?: 'stdio' | 'remote',
  /** 工作区处置（可选；缺省 = 不干预，改造前行为）。 */
  workspaceContext?: McpWorkspaceContext,
): Tool {
  const rivetName = mcpToolName(serverId, mcpDef.name)
  const desc = mcpDef.description ?? `MCP tool: ${mcpDef.name} (from ${serverId})`
  const policy = evaluateMcpPolicy({
    toolName: rivetName,
    declaredCapability: securityPolicy?.capability,
    trustedServers: [],
    blockedTools: [],
    allowedTools: [],
    mustConfirmCapabilities: ['write', 'execute', 'network'],
  })
  const needsApproval = securityPolicy?.requireApproval === true || policy.action !== 'allow'

  return {
    definition: {
      name: rivetName,
      description: desc,
      capability: securityPolicy?.capability,
      input_schema: {
        type: 'object',
        properties: mcpDef.inputSchema.properties ?? {},
        required: mcpDef.inputSchema.required,
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      // By the time execute runs, the connector use was either approval-free or
      // approved — record the opt-in so later read-only calls don't re-prompt.
      consent?.grantConsent(serverId)
      // issue #147 — 工作区判定：声明过的 server 按策略补齐缺失的工作区参数
      // （显式值永不改写），并在结果尾部明示本次落点。会话 cwd 取自 params.cwd。
      const planned = workspaceContext
        ? resolveSubAgentWorkspace({
            args: params.input,
            declaration: workspaceContext.declaration,
            policy: workspaceContext.policy,
            sessionCwd: params.cwd,
            scratchRoot: workspaceContext.scratchRoot,
            scratchKey: params.toolUseId,
          })
        : null
      // 只在真的干预过时加明示行——untouched/explicit 与改造前的输出逐字节一致。
      const workdirSuffix = (text: string): string => {
        if (!planned || planned.source === 'untouched' || planned.source === 'explicit') return ''
        const actual = readWorkspaceReceipt(text, workspaceContext?.declaration) ?? planned.path ?? '(unknown)'
        return `\n[workdir: ${actual} · ${planned.source}]`
      }
      try {
        const result = await callTool(planned ? planned.args : params.input)
        const textParts = result.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map(c => c.text)
        const content = textParts.join('\n') || '(no text content)'

        const annotation = `[MCP: ${serverId} · ${policy.capability}${needsApproval ? ' · approval-required' : ''}]`

        if (result.isError) {
          // 模型只需知道"失败 + 首行原因"，不必把整段服务器错误文本灌进上下文；
          // 完整原文走 uiContent 供 TUI 展示。
          const firstLine = content.split('\n')[0]!.slice(0, 200)
          // 失败时更要明示落点：工作区参数本身出错（目录不存在/无权限）时，
          // 模型只有看到注入了什么才能给出可执行的下一步。
          const suffix = workdirSuffix(content)
          return {
            content: `${annotation} · tool error\n${firstLine}${suffix}`,
            uiContent: `${annotation} · tool error\n${content}${suffix}`,
            isError: true,
          }
        }
        return { content: `${content}\n${annotation}${workdirSuffix(content)}` }
      } catch (err) {
        const classified = classifyMcpError(err, { transport })
        const annotation = `[MCP: ${serverId} · ${policy.capability}${needsApproval ? ' · approval-required' : ''} · error: ${classified.class} · ${classified.suggestion}]`
        // annotation 已含 class + suggestion 作为精简信号；模型 content 只取错误首行，
        // 完整消息走 uiContent。
        const fullMsg = err instanceof Error ? err.message : String(err)
        const firstLine = fullMsg.split('\n')[0]!.slice(0, 200)
        const suffix = workdirSuffix(fullMsg)
        return {
          content: `MCP tool error (${rivetName}): ${firstLine}\n${annotation}${suffix}`,
          uiContent: `MCP tool error (${rivetName}): ${fullMsg}\n${annotation}${suffix}`,
          isError: true,
        }
      }
    },

    requiresApproval(_params: ToolCallParams): boolean {
      // Undeclared or non-read capabilities require approval on every call.
      // Declared read-only tools still require a one-time connector opt-in.
      if (needsApproval) return true
      if (consent && !consent.hasConsented(serverId)) return true
      return false
    },

    isConcurrencySafe(): boolean {
      return true
    },

    isEnabled(): boolean {
      return true
    },
  }
}
