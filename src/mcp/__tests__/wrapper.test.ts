import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { createMcpToolWrapper, createMcpConnectorConsent, mcpToolName } from '../wrapper.js'

describe('mcpToolName', () => {
  it('prefixes with server id', () => {
    assert.equal(mcpToolName('github', 'create_issue'), 'mcp__github__create_issue')
  })

  it('handles tool names with slashes', () => {
    assert.equal(mcpToolName('ctx7', 'resolve-library-id'), 'mcp__ctx7__resolve-library-id')
  })
})

describe('createMcpToolWrapper', () => {
  it('wraps MCP tool definition as Rivet Tool', () => {
    const mcpDef = {
      name: 'search',
      description: 'Search the web',
      inputSchema: {
        type: 'object' as const,
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    }
    const callTool = async (_input: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: 'result text' }],
      isError: false,
    })
    const tool = createMcpToolWrapper('web', mcpDef, callTool)

    assert.equal(tool.definition.name, 'mcp__web__search')
    assert.equal(tool.definition.description, 'Search the web')
    assert.ok(tool.isEnabled())
    assert.ok(tool.isConcurrencySafe())
  })

  it('executes via callTool and returns string content', async () => {
    const mcpDef = {
      name: 'echo',
      description: 'Echo input',
      inputSchema: { type: 'object' as const, properties: { msg: { type: 'string' } } },
    }
    const callTool = async (input: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: `Echo: ${input.msg}` }],
      isError: false,
    })
    const tool = createMcpToolWrapper('test', mcpDef, callTool)
    const result = await tool.execute({
      input: { msg: 'hello' },
      toolUseId: 'tu_1',
      cwd: '/tmp',
    })
    assert.equal(result.content, 'Echo: hello\n[MCP: test · unknown · approval-required]')
    assert.equal(result.isError, undefined)
  })

  it('handles MCP error responses', async () => {
    const mcpDef = {
      name: 'fail',
      description: 'Always fails',
      inputSchema: { type: 'object' as const, properties: {} },
    }
    const callTool = async () => ({
      content: [{ type: 'text' as const, text: 'Server error' }],
      isError: true,
    })
    const tool = createMcpToolWrapper('test', mcpDef, callTool)
    const result = await tool.execute({
      input: {},
      toolUseId: 'tu_1',
      cwd: '/tmp',
    })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('Server error'))
  })

  it('handles callTool exceptions gracefully', async () => {
    const mcpDef = {
      name: 'crash',
      description: 'Crashes',
      inputSchema: { type: 'object' as const, properties: {} },
    }
    const callTool = async () => { throw new Error('Connection lost') }
    const tool = createMcpToolWrapper('test', mcpDef, callTool)
    const result = await tool.execute({
      input: {},
      toolUseId: 'tu_1',
      cwd: '/tmp',
    })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('Connection lost'))
  })

  it('MCP tool error: model content is concise (first line), full text in uiContent', async () => {
    const mcpDef = {
      name: 'fail',
      description: 'Always fails',
      inputSchema: { type: 'object' as const, properties: {} },
    }
    const bigError = 'Server error: root cause here\n' + Array.from({ length: 50 }, (_, i) => `stack frame ${i}`).join('\n')
    const callTool = async () => ({ content: [{ type: 'text' as const, text: bigError }], isError: true })
    const tool = createMcpToolWrapper('test', mcpDef, callTool)
    const result = await tool.execute({ input: {}, toolUseId: 'tu_1', cwd: '/tmp' })

    assert.equal(result.isError, true)
    assert.ok(result.content.includes('root cause here'), 'model sees the first-line reason')
    assert.ok(!result.content.includes('stack frame 40'), 'model does NOT get the full stack dump')
    assert.ok(result.uiContent && result.uiContent.includes('stack frame 49'), 'uiContent keeps full text for TUI')
  })

  it('MCP exception: model content concise, full message in uiContent', async () => {
    const mcpDef = {
      name: 'crash',
      description: 'Crashes',
      inputSchema: { type: 'object' as const, properties: {} },
    }
    const callTool = async () => { throw new Error('Connection lost\nverbose detail line') }
    const tool = createMcpToolWrapper('test', mcpDef, callTool)
    const result = await tool.execute({ input: {}, toolUseId: 'tu_1', cwd: '/tmp' })

    assert.equal(result.isError, true)
    assert.ok(result.content.includes('Connection lost'))
    assert.ok(!result.content.includes('verbose detail line'), 'model content omits the verbose tail')
    assert.ok(result.uiContent && result.uiContent.includes('verbose detail line'), 'uiContent keeps full message')
  })

  it('converts MCP inputSchema to Rivet input_schema', () => {
    const mcpDef = {
      name: 'write',
      description: 'Write file',
      inputSchema: {
        type: 'object' as const,
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    }
    const callTool = async () => ({ content: [{ type: 'text' as const, text: 'ok' }], isError: false })
    const tool = createMcpToolWrapper('fs', mcpDef, callTool)

    assert.deepEqual(tool.definition.input_schema?.required, ['path', 'content'])
    assert.equal((tool.definition.input_schema?.properties as any).path.description, 'File path')
  })

  it('requires approval for undeclared MCP tools', () => {
    const mcpDef = {
      name: 'create_file',
      description: 'Create or overwrite a file',
      inputSchema: { type: 'object' as const, properties: {} },
    }
    const callTool = async () => ({ content: [{ type: 'text' as const, text: '' }], isError: false })
    const tool = createMcpToolWrapper('fs', mcpDef, callTool)

    assert.equal(tool.requiresApproval({ input: {}, toolUseId: '1', cwd: '/tmp' }), true)
  })

  it('allows declared read-only tools without a consent store', () => {
    const mcpDef = {
      name: 'search_code',
      description: 'Search code in repository',
      inputSchema: { type: 'object' as const, properties: {} },
    }
    const callTool = async () => ({ content: [{ type: 'text' as const, text: '' }], isError: false })
    const tool = createMcpToolWrapper('grep', mcpDef, callTool, undefined, { capability: 'read' })

    assert.equal(tool.requiresApproval({ input: {}, toolUseId: '1', cwd: '/tmp' }), false)
  })
})

describe('MCP connector opt-in (first-use consent)', () => {
  const readDef = {
    name: 'search_code',
    description: 'Search code in repository',
    inputSchema: { type: 'object' as const, properties: {} },
  }
  const okCall = async () => ({ content: [{ type: 'text' as const, text: 'ok' }], isError: false })
  const callParams = { input: {}, toolUseId: '1', cwd: '/tmp' }

  it('requires approval on first use of a connector when consent is wired', () => {
    const consent = createMcpConnectorConsent()
    const tool = createMcpToolWrapper('ctx7', readDef, okCall, consent, { capability: 'read' })
    assert.equal(tool.requiresApproval(callParams), true)
  })

  it('stops requiring approval after the connector has been used (opted in)', async () => {
    const consent = createMcpConnectorConsent()
    const tool = createMcpToolWrapper('ctx7', readDef, okCall, consent, { capability: 'read' })
    assert.equal(tool.requiresApproval(callParams), true)
    await tool.execute(callParams)
    assert.equal(tool.requiresApproval(callParams), false)
  })

  it('opt-in is per connector — approving one does not unlock another', async () => {
    const consent = createMcpConnectorConsent()
    const a = createMcpToolWrapper('serverA', readDef, okCall, consent, { capability: 'read' })
    const b = createMcpToolWrapper('serverB', readDef, okCall, consent, { capability: 'read' })
    await a.execute(callParams)
    assert.equal(a.requiresApproval(callParams), false)
    assert.equal(b.requiresApproval(callParams), true)
  })

  it('write-capable tools still require approval even after opt-in', async () => {
    const consent = createMcpConnectorConsent()
    const writeDef = {
      name: 'create_issue',
      description: 'Create an issue',
      inputSchema: { type: 'object' as const, properties: {} },
    }
    const tool = createMcpToolWrapper('gh', writeDef, okCall, consent, { capability: 'write' })
    await tool.execute(callParams)
    assert.equal(tool.requiresApproval(callParams), true)
  })

  it('without a consent store, declared read-only tools do not need approval', () => {
    const tool = createMcpToolWrapper('ctx7', readDef, okCall, undefined, { capability: 'read' })
    assert.equal(tool.requiresApproval(callParams), false)
  })

  it('requires approval on every call for an undeclared mutating tool', async () => {
    const consent = createMcpConnectorConsent()
    const tool = createMcpToolWrapper('unknown', { ...readDef, name: 'mutate' }, okCall, consent)
    await tool.execute(callParams)
    assert.equal(tool.requiresApproval(callParams), true)
  })
})

// issue #147 — 子 Agent 工作区策略在 wrapper 层的落点：缺省不干预、
// 缺失才注入、每次干预都在结果尾部明示（对方回执优先）。
describe('workspace policy (issue #147)', () => {
  const mcpDef = {
    name: 'run_task',
    description: 'Dispatch a task',
    inputSchema: {
      type: 'object' as const,
      properties: { projectPath: { type: 'string' }, task: { type: 'string' } },
    },
  }
  const wsCtx = { declaration: { arg: 'projectPath' }, policy: 'reuse-session' as const, scratchRoot: '/scratch' }

  const captureCall = (capture: (input: Record<string, unknown>) => void) =>
    async (input: Record<string, unknown>) => {
      capture(input)
      return { content: [{ type: 'text' as const, text: 'queued' }], isError: false }
    }

  it('未挂 workspaceContext → 参数原样透传（改造前行为）', async () => {
    let seen: Record<string, unknown> = {}
    const tool = createMcpToolWrapper('tianshu-mcp', mcpDef, captureCall((i) => { seen = i }))
    const res = await tool.execute({ input: { task: 'x' }, toolUseId: 't1', cwd: '/repo/app' })
    assert.deepEqual(seen, { task: 'x' })
    assert.doesNotMatch(String(res.content), /workdir/)
  })

  it('工作区参数缺失 → 注入会话 cwd，并在结果尾部明示', async () => {
    let seen: Record<string, unknown> = {}
    const tool = createMcpToolWrapper('tianshu-mcp', mcpDef, captureCall((i) => { seen = i }), undefined, undefined, undefined, wsCtx)
    const res = await tool.execute({ input: { task: 'x' }, toolUseId: 't1', cwd: '/repo/app' })
    assert.equal(seen.projectPath, '/repo/app')
    assert.match(String(res.content), /\[workdir: \/repo\/app · session\]/)
  })

  it('模型已给工作区 → 不改写、不加明示行（不制造噪声）', async () => {
    let seen: Record<string, unknown> = {}
    const tool = createMcpToolWrapper('tianshu-mcp', mcpDef, captureCall((i) => { seen = i }), undefined, undefined, undefined, wsCtx)
    const res = await tool.execute({ input: { projectPath: '/model/pick', task: 'x' }, toolUseId: 't1', cwd: '/repo/app' })
    assert.equal(seen.projectPath, '/model/pick')
    assert.doesNotMatch(String(res.content), /workdir/)
  })

  it('对方回执里的工作区优先于注入值（明示事实而非意图）', async () => {
    const body = JSON.stringify({ boundProjectPath: '/zcode/bound' })
    const text = `queued\n---tianshu-mcp-meta---\n${body}\n---tianshu-mcp-meta---`
    const tool = createMcpToolWrapper(
      'tianshu-mcp',
      mcpDef,
      async () => ({ content: [{ type: 'text' as const, text }], isError: false }),
      undefined,
      undefined,
      undefined,
      {
        declaration: { arg: 'projectPath', metaMarker: '---tianshu-mcp-meta---', pathField: 'boundProjectPath' },
        policy: 'reuse-session',
        scratchRoot: '/scratch',
      },
    )
    const res = await tool.execute({ input: {}, toolUseId: 't1', cwd: '/repo/app' })
    assert.match(String(res.content), /\[workdir: \/zcode\/bound · session\]/)
  })

  it('isolated 策略 → 注入隔离目录（不碰用户项目）', async () => {
    let seen: Record<string, unknown> = {}
    const tool = createMcpToolWrapper(
      'tianshu-mcp',
      mcpDef,
      captureCall((i) => { seen = i }),
      undefined,
      undefined,
      undefined,
      { ...wsCtx, policy: 'isolated' as const },
    )
    const res = await tool.execute({ input: {}, toolUseId: 't1', cwd: '/repo/app' })
    assert.equal(seen.projectPath, join('/scratch', 't1'))
    assert.match(String(res.content), /· isolated\]/)
  })

  it('工具返回 isError → 仍明示工作区落点（失败时最需要知道注入了什么）', async () => {
    const tool = createMcpToolWrapper(
      'tianshu-mcp',
      mcpDef,
      async () => ({ content: [{ type: 'text' as const, text: 'boom: permission denied' }], isError: true }),
      undefined,
      undefined,
      undefined,
      wsCtx,
    )
    const res = await tool.execute({ input: { task: 'x' }, toolUseId: 't1', cwd: '/repo/app' })
    assert.equal(res.isError, true)
    assert.match(String(res.content), /\[workdir: \/repo\/app · session\]/)
  })

  it('工具抛错 → 仍明示工作区落点', async () => {
    const tool = createMcpToolWrapper(
      'tianshu-mcp',
      mcpDef,
      async () => { throw new Error('spawn failed') },
      undefined,
      undefined,
      undefined,
      wsCtx,
    )
    const res = await tool.execute({ input: { task: 'x' }, toolUseId: 't1', cwd: '/repo/app' })
    assert.equal(res.isError, true)
    assert.match(String(res.content), /\[workdir: \/repo\/app · session\]/)
  })

  it('显式工作区已给且失败 → 不加明示（与改造前逐字节一致）', async () => {
    const tool = createMcpToolWrapper(
      'tianshu-mcp',
      mcpDef,
      async () => ({ content: [{ type: 'text' as const, text: 'boom' }], isError: true }),
      undefined,
      undefined,
      undefined,
      wsCtx,
    )
    const res = await tool.execute({ input: { projectPath: '/model/pick', task: 'x' }, toolUseId: 't1', cwd: '/repo/app' })
    assert.equal(res.isError, true)
    assert.doesNotMatch(String(res.content), /workdir/)
  })
})
