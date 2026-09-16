import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  resolveNpmCliCommand,
  buildStdioEnvWithNodePath,
} from '../resolve-node-cli.js'

describe('resolveNpmCliCommand', () => {
  it('rewrites bare npx to node + npx-cli.js on win32 layout', () => {
    const execPath = 'C:\\app\\node-runtime\\win-x64\\node.exe'
    const cli = 'C:\\app\\node-runtime\\win-x64\\node_modules\\npm\\bin\\npx-cli.js'
    const r = resolveNpmCliCommand('npx', ['-y', '@pkg/mcp'], {
      execPath,
      platform: 'win32',
      existsSync: (p) => p === cli,
    })
    assert.equal(r.command, execPath)
    assert.deepEqual(r.args, [cli, '-y', '@pkg/mcp'])
  })

  it('rewrites npx.cmd the same way', () => {
    const execPath = 'C:\\app\\node.exe'
    const cli = 'C:\\app\\node_modules\\npm\\bin\\npx-cli.js'
    const r = resolveNpmCliCommand('npx.cmd', ['-y', 'x'], {
      execPath,
      platform: 'win32',
      existsSync: (p) => p === cli,
    })
    assert.equal(r.command, execPath)
    assert.equal(r.args[0], cli)
  })

  it('rewrites npm on unix lib/ layout', () => {
    const execPath = '/opt/node/bin/node'
    const cli = '/opt/node/lib/node_modules/npm/bin/npm-cli.js'
    const r = resolveNpmCliCommand('npm', ['install'], {
      execPath,
      platform: 'darwin',
      existsSync: (p) => p === cli,
    })
    assert.equal(r.command, execPath)
    assert.deepEqual(r.args, [cli, 'install'])
  })

  it('passes through unknown commands', () => {
    const r = resolveNpmCliCommand('python', ['-m', 'server'], {
      existsSync: () => true,
    })
    assert.equal(r.command, 'python')
    assert.deepEqual(r.args, ['-m', 'server'])
  })

  it('passes through npx when cli.js is missing', () => {
    const r = resolveNpmCliCommand('npx', ['-y', 'x'], {
      execPath: '/usr/bin/node',
      platform: 'linux',
      existsSync: () => false,
    })
    assert.equal(r.command, 'npx')
    assert.deepEqual(r.args, ['-y', 'x'])
  })
})

describe('buildStdioEnvWithNodePath', () => {
  it('always prepends nodeDir and keeps user PATH after it', () => {
    const env = buildStdioEnvWithNodePath(
      { PATH: '/usr/bin', TOKEN: 'secret' },
      {
        execPath: '/opt/node/bin/node',
        platform: 'linux',
        getDefaultEnvironment: () => ({ PATH: '/default', HOME: '/home/u' }),
      },
    )
    assert.equal(env.TOKEN, 'secret')
    assert.equal(env.HOME, '/home/u')
    assert.equal(env.PATH, '/opt/node/bin:/usr/bin')
  })

  it('user PATH cannot displace nodeDir (written last)', () => {
    const env = buildStdioEnvWithNodePath(
      { PATH: 'C:\\Users\\me' },
      {
        execPath: 'C:\\app\\node.exe',
        platform: 'win32',
        getDefaultEnvironment: () => ({ PATH: 'C:\\Windows' }),
      },
    )
    assert.ok(env.PATH?.startsWith(`C:\\app;`))
    assert.ok(env.PATH?.includes('C:\\Users\\me'))
  })

  it('works when cfg.env is omitted', () => {
    const env = buildStdioEnvWithNodePath(undefined, {
      execPath: join('/opt', 'node', 'bin', 'node'),
      platform: 'darwin',
      getDefaultEnvironment: () => ({ PATH: '/usr/bin' }),
    })
    assert.ok(env.PATH?.startsWith(join('/opt', 'node', 'bin') + ':'))
  })

  // ── issue #149：基座 PATH 缺失时的静默退化 ──────────────────────────
  // 旧实现 `PATH: pathRest ? nodeDir+sep+pathRest : nodeDir` 在基座给不出 PATH 时
  // 只留 node 目录。npx 解析包要 spawn cmd.exe，它不在 node 目录里——子进程秒退，
  // 报出来只是 -32000，看不出根因。

  it('基座 PATH 缺失时补系统目录，而不是只剩 nodeDir', () => {
    const env = buildStdioEnvWithNodePath(undefined, {
      execPath: 'C:\\app\\node.exe',
      platform: 'win32',
      // MCP SDK 1.29.0 之前的 win32 白名单就是这样：有 SYSTEMROOT 没有 PATH。
      getDefaultEnvironment: () => ({ SYSTEMROOT: 'C:\\Windows' }),
    })
    assert.equal(
      env.PATH,
      'C:\\app;C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem',
      'PATH 只剩 node 目录时 npx 找不到 cmd.exe',
    )
  })

  it('兜底读 SystemRoot，不硬写 C:\\Windows（系统装在非 C 盘时硬写等于没兜底）', () => {
    const env = buildStdioEnvWithNodePath(undefined, {
      execPath: 'D:\\app\\node.exe',
      platform: 'win32',
      getDefaultEnvironment: () => ({ SYSTEMROOT: 'D:\\Win' }),
    })
    assert.ok(env.PATH?.includes('D:\\Win\\System32'))
    assert.ok(!env.PATH?.includes('C:\\Windows'))
  })

  it('基座 PATH 正常时不追加兜底目录（行为与改动前逐字一致）', () => {
    const env = buildStdioEnvWithNodePath(undefined, {
      execPath: 'C:\\app\\node.exe',
      platform: 'win32',
      getDefaultEnvironment: () => ({ PATH: 'C:\\Windows\\System32', SYSTEMROOT: 'C:\\Windows' }),
    })
    assert.equal(env.PATH, 'C:\\app;C:\\Windows\\System32')
  })

  it('POSIX 不猜系统目录——基座缺 PATH 时宁可只给 nodeDir', () => {
    const env = buildStdioEnvWithNodePath(undefined, {
      execPath: '/opt/node/bin/node',
      platform: 'linux',
      getDefaultEnvironment: () => ({}),
    })
    assert.equal(env.PATH, '/opt/node/bin')
  })
})
