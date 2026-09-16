import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  resolveSubAgentWorkspace,
  readWorkspaceReceipt,
  workspaceDeclarationFor,
  BUILTIN_WORKSPACE_DECLARATIONS,
} from '../workspace-policy.js'
import type { McpServerWorkspaceDeclaration } from '../config.js'

const declaration: McpServerWorkspaceDeclaration = {
  arg: 'projectPath',
  agentArg: 'agentId',
  noProjectAgents: ['zcode'],
  metaMarker: '---tianshu-mcp-meta---',
  pathField: 'boundProjectPath',
}

const base = {
  declaration,
  sessionCwd: '/repo/app',
  scratchRoot: '/home/u/.rivet/workspace/mcp',
  scratchKey: 'abcd1234',
}

describe('resolveSubAgentWorkspace 判定表（issue #147）', () => {
  test('无声明 → untouched（args 原样，生态中立）', () => {
    const args = { projectPath: undefined, other: 1 }
    const plan = resolveSubAgentWorkspace({ ...base, declaration: undefined, policy: 'reuse-session', args })
    assert.equal(plan.source, 'untouched')
    assert.equal(plan.args, args, '不干预时必须返回同一个对象引用（零拷贝、零改写）')
  })

  test("policy='off' + 有声明 → 仍 untouched（与改造前逐字节一致）", () => {
    const args = { other: 1 }
    const plan = resolveSubAgentWorkspace({ ...base, policy: 'off', args })
    assert.equal(plan.source, 'untouched')
    assert.deepEqual(plan.args, { other: 1 })
  })

  test('模型已给工作区 → explicit，原样透传（绝不覆写显式意图）', () => {
    const args = { projectPath: '/model/chosen' }
    const plan = resolveSubAgentWorkspace({ ...base, policy: 'reuse-session', args })
    assert.equal(plan.source, 'explicit')
    assert.equal(plan.path, '/model/chosen')
    assert.deepEqual(plan.args, { projectPath: '/model/chosen' })
  })

  test('缺失 + reuse-session → 注入当前会话 cwd', () => {
    const plan = resolveSubAgentWorkspace({ ...base, policy: 'reuse-session', args: { task: 'x' } })
    assert.equal(plan.source, 'session')
    assert.equal(plan.path, '/repo/app')
    assert.equal((plan.args as { projectPath?: string }).projectPath, '/repo/app')
    assert.equal((plan.args as { task?: string }).task, 'x', '其余参数不动')
  })

  test('缺失 + isolated → 注入隔离目录（不碰用户项目）', () => {
    const plan = resolveSubAgentWorkspace({ ...base, policy: 'isolated', args: {} })
    assert.equal(plan.source, 'isolated')
    assert.equal(plan.path, join('/home/u/.rivet/workspace/mcp', 'abcd1234'))
  })

  test('空白字符串视为缺失（不是「用户指定了空格路径」）', () => {
    const plan = resolveSubAgentWorkspace({ ...base, policy: 'reuse-session', args: { projectPath: '   ' } })
    assert.equal(plan.source, 'session')
    assert.equal((plan.args as { projectPath?: string }).projectPath, '/repo/app')
  })

  test('no-project + agent 在名单内 → 保持省略（对方 default 工作区，不登记项目）', () => {
    const plan = resolveSubAgentWorkspace({ ...base, policy: 'no-project', args: { agentId: 'zcode' } })
    assert.equal(plan.source, 'no-project')
    assert.equal(plan.path, undefined)
    assert.ok(!('projectPath' in plan.args), '不得注入任何工作区参数')
  })

  test('no-project + agent 不在名单内 → 退回复用会话 cwd（对方省略会报错）', () => {
    const plan = resolveSubAgentWorkspace({ ...base, policy: 'no-project', args: { agentId: 'codex' } })
    assert.equal(plan.source, 'session')
    assert.equal((plan.args as { projectPath?: string }).projectPath, '/repo/app')
  })

  test('no-project + 未声明 agentArg → 退回复用会话 cwd', () => {
    const plan = resolveSubAgentWorkspace({
      ...base,
      declaration: { arg: 'projectPath' },
      policy: 'no-project',
      args: { agentId: 'zcode' },
    })
    assert.equal(plan.source, 'session')
  })

  test('不修改调用方传入的 args 对象（不可变性）', () => {
    const args: Record<string, unknown> = { task: 'x' }
    resolveSubAgentWorkspace({ ...base, policy: 'reuse-session', args })
    assert.deepEqual(args, { task: 'x' }, '注入必须发生在副本上')
  })
})

describe('readWorkspaceReceipt 回执解析', () => {
  const body = JSON.stringify({ taskId: 't1', boundProjectPath: '/zcode/bound/app', projectPath: '/p' }, null, 2)
  const text = `任务已排队。\n---tianshu-mcp-meta---\n${body}\n---tianshu-mcp-meta---`

  test('从成对 marker 之间取多行 JSON（tianshu-mcp formatter 的真实形状）', () => {
    assert.equal(readWorkspaceReceipt(text, declaration), '/zcode/bound/app')
  })

  test('无 marker → undefined（不猜）', () => {
    assert.equal(readWorkspaceReceipt('任务已排队。', declaration), undefined)
  })

  test('marker 未配对（只有一个）→ 仍尝试解析其后的 JSON', () => {
    const single = `---tianshu-mcp-meta---\n${body}`
    assert.equal(readWorkspaceReceipt(single, declaration), '/zcode/bound/app')
  })

  test('缺少声明或字段 → undefined', () => {
    assert.equal(readWorkspaceReceipt(text, { arg: 'projectPath' }), undefined)
    assert.equal(readWorkspaceReceipt(text, { ...declaration, pathField: 'nope' }), undefined)
  })

  test('畸形 JSON → undefined（不抛错、不编造）', () => {
    const broken = `---tianshu-mcp-meta---\n{ not json\n---tianshu-mcp-meta---`
    assert.equal(readWorkspaceReceipt(broken, declaration), undefined)
  })

  test('字段非字符串 → undefined', () => {
    const odd = `---tianshu-mcp-meta---\n${JSON.stringify({ boundProjectPath: 42 })}\n---tianshu-mcp-meta---`
    assert.equal(readWorkspaceReceipt(odd, declaration), undefined)
  })
})

describe('workspaceDeclarationFor 声明来源', () => {
  test('内置表命中 tianshu-mcp（开箱生效，无需用户配置）', () => {
    const d = workspaceDeclarationFor('tianshu-mcp')
    assert.equal(d, BUILTIN_WORKSPACE_DECLARATIONS['tianshu-mcp'])
    assert.equal(d?.arg, 'projectPath')
    assert.deepEqual(d?.noProjectAgents, ['zcode'])
    assert.equal(d?.pathField, 'boundProjectPath')
  })

  test('用户配置优先于内置表', () => {
    const configured = { arg: 'workspacePath' }
    assert.equal(workspaceDeclarationFor('tianshu-mcp', configured), configured)
  })

  test('未声明的 server → undefined（天枢不干预）', () => {
    assert.equal(workspaceDeclarationFor('some-other-server'), undefined)
  })
})
