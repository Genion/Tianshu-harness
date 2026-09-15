import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { resolveSessionWorkspace, sessionScratchRoot, isSessionWorkspaceMode } from '../workspace.js'

// 判定表逐格断言（issue #147 诉求 1）。每格对应计划里的一行，不合并——
// 合并后单格回归会静默通过。

test('requested 非空 → explicit，无论 mode', () => {
  for (const mode of ['explicit', 'default', 'scratch'] as const) {
    const r = resolveSessionWorkspace({
      requested: '/work/app',
      mode,
      configDefaultDir: '/work/default',
      processCwd: '/proc',
      scratchRoot: '/scratch',
      sessionId: 'abcdef1234567890',
    })
    assert.deepEqual(r, { path: '/work/app', source: 'explicit', managed: false })
  }
})

test('requested 为空白字符串视为缺失（不把空格当路径）', () => {
  const r = resolveSessionWorkspace({
    requested: '   ',
    processCwd: '/proc',
    scratchRoot: '/scratch',
    sessionId: 'abcdef12',
  })
  assert.deepEqual(r, { path: '/proc', source: 'runtime-default', managed: false })
})

test('缺省 mode（旧客户端）= 今天的语义：落到 processCwd', () => {
  const r = resolveSessionWorkspace({
    processCwd: '/proc',
    configDefaultDir: '/work/default',
    scratchRoot: '/scratch',
    sessionId: 'abcdef12',
  })
  assert.deepEqual(r, { path: '/proc', source: 'runtime-default', managed: false })
})

test("mode='explicit' 显式传入同样落到 processCwd（配置不介入）", () => {
  const r = resolveSessionWorkspace({
    mode: 'explicit',
    processCwd: '/proc',
    configDefaultDir: '/work/default',
    scratchRoot: '/scratch',
    sessionId: 'abcdef12',
  })
  assert.deepEqual(r, { path: '/proc', source: 'runtime-default', managed: false })
})

test("mode='default' + 已配默认工作区 → config-default", () => {
  const r = resolveSessionWorkspace({
    mode: 'default',
    processCwd: '/proc',
    configDefaultDir: '/work/default',
    scratchRoot: '/scratch',
    sessionId: 'abcdef12',
  })
  assert.deepEqual(r, { path: '/work/default', source: 'config-default', managed: false })
})

test("mode='default' + 未配默认工作区 → 回落 processCwd（fail-open 到旧行为）", () => {
  const r = resolveSessionWorkspace({
    mode: 'default',
    processCwd: '/proc',
    scratchRoot: '/scratch',
    sessionId: 'abcdef12',
  })
  assert.deepEqual(r, { path: '/proc', source: 'runtime-default', managed: false })
})

test("mode='default' + 默认工作区为空白 → 同样回落", () => {
  const r = resolveSessionWorkspace({
    mode: 'default',
    configDefaultDir: '  ',
    processCwd: '/proc',
    scratchRoot: '/scratch',
    sessionId: 'abcdef12',
  })
  assert.deepEqual(r, { path: '/proc', source: 'runtime-default', managed: false })
})

test("mode='scratch' → 隔离目录 = <scratchRoot>/<sessionId 前 8 位>，managed=true", () => {
  const r = resolveSessionWorkspace({
    mode: 'scratch',
    configDefaultDir: '/work/default',
    processCwd: '/proc',
    scratchRoot: '/scratch',
    sessionId: 'abcdef12-3456-7890',
  })
  assert.deepEqual(r, { path: join('/scratch', 'abcdef12'), source: 'scratch', managed: true })
})

test('sessionId 短于 8 位时原样用作目录名（不产生空段）', () => {
  const r = resolveSessionWorkspace({
    mode: 'scratch',
    processCwd: '/proc',
    scratchRoot: '/scratch',
    sessionId: 'abc',
  })
  assert.deepEqual(r, { path: join('/scratch', 'abc'), source: 'scratch', managed: true })
})

test('sessionScratchRoot 把 rivetHome 拼成 <home>/workspace', () => {
  assert.equal(sessionScratchRoot('/home/u/.rivet'), join('/home/u/.rivet', 'workspace'))
})

test('~ 展开：requested 与 configDefaultDir 都以 home 为基准（homeDir 注入）', () => {  const explicit = resolveSessionWorkspace({
    requested: '~/work/app',
    processCwd: '/proc',
    scratchRoot: '/scratch',
    sessionId: 'abcdef12',
    homeDir: '/home/u',
  })
  assert.equal(explicit.path, join('/home/u', 'work', 'app'))

  const configured = resolveSessionWorkspace({
    mode: 'default',
    configDefaultDir: '~/projects',
    processCwd: '/proc',
    scratchRoot: '/scratch',
    sessionId: 'abcdef12',
    homeDir: '/home/u',
  })
  assert.equal(configured.path, join('/home/u', 'projects'))
  assert.equal(configured.source, 'config-default')
})

test('isSessionWorkspaceMode 只接受三个合法值（HTTP 层据此 400）', () => {
  assert.equal(isSessionWorkspaceMode('explicit'), true)
  assert.equal(isSessionWorkspaceMode('default'), true)
  assert.equal(isSessionWorkspaceMode('scratch'), true)
  assert.equal(isSessionWorkspaceMode('EXPLICIT'), false)
  assert.equal(isSessionWorkspaceMode(''), false)
  assert.equal(isSessionWorkspaceMode(undefined), false)
  assert.equal(isSessionWorkspaceMode(null), false)
  assert.equal(isSessionWorkspaceMode(42), false)
})
