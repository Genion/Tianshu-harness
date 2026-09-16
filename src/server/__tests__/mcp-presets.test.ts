import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MCP_PRESETS, findMcpPreset } from '../../mcp/presets.js'
import { buildMcpRoutes } from '../mcp-api.js'
import { createTransport } from '../../mcp/transport-factory.js'

test('MCP_PRESETS have unique ids', () => {
  const ids = MCP_PRESETS.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('each preset is a well-formed transport config', () => {
  for (const p of MCP_PRESETS) {
    if (p.transport === 'stdio') {
      assert.ok(p.command, `${p.id} stdio preset must have a command`)
      assert.ok(!p.url, `${p.id} stdio preset must not have a url`)
    } else {
      assert.ok(p.url, `${p.id} sse preset must have a url`)
      assert.ok(!p.command, `${p.id} sse preset must not have a command`)
    }
    for (const env of p.requiredEnv ?? []) {
      assert.ok(env.key && env.label, `${p.id} requiredEnv fields need key + label`)
    }
  }
})

test('findMcpPreset resolves by id', () => {
  assert.equal(findMcpPreset('github')?.name, 'GitHub')
  assert.equal(findMcpPreset('nope'), undefined)
})

/**
 * 隔离 RIVET_HOME——预设/配置读写都落在这个根下（同 mcp-hot-add.test.ts 的模式）。
 */
function withTempHome(fn: () => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-presets-'))
  const prev = process.env.RIVET_HOME
  process.env.RIVET_HOME = dir
  return fn().finally(() => {
    if (prev === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prev
    rmSync(dir, { recursive: true, force: true })
  })
}

// ── 来源标注（issue #145：接入的第三方 MCP 必须可归因） ────────────────
// 卡片要显示「谁维护的、仓库在哪」，字段形态由这里兜底：缺名字、非 https
// 的链接在 UI 上会变成打不开的死链——与其上线后靠肉眼发现，不如在这里红。

test('preset provenance: author / repoUrl / docsUrl are well-formed when present', () => {
  for (const p of MCP_PRESETS) {
    if (p.author) {
      assert.ok(p.author.name.trim().length > 0, `${p.id} author needs a display name`)
      if (p.author.url) assert.match(p.author.url, /^https:\/\/\S+$/, `${p.id} author.url must be https`)
    }
    if (p.repoUrl) assert.match(p.repoUrl, /^https:\/\/\S+$/, `${p.id} repoUrl must be https`)
    if (p.docsUrl) assert.match(p.docsUrl, /^https:\/\/\S+$/, `${p.id} docsUrl must be https`)
  }
})

test('tianshu-mcp preset: 官方 MCP 条目契约（作者 / 仓库 / 工具面）', () => {
  const p = findMcpPreset('tianshu-mcp')
  assert.ok(p, 'tianshu-mcp preset must exist')
  assert.equal(p.transport, 'stdio')
  assert.equal(p.command, 'npx')
  assert.deepEqual(p.args, ['-y', 'tianshu-mcp'])
  assert.equal(p.author?.name, 'lanlan0811', '作者信息缺失则卡片无从归因')
  assert.equal(p.author?.url, 'https://github.com/lanlan0811')
  assert.equal(p.repoUrl, 'https://github.com/lanlan0811/tianshu-mcp')
  assert.equal(p.expectedTools?.length, 9, '上游暴露 9 个工具')
})

// ── 默认关闭 / 显式开启（用户对本次接入的硬要求） ─────────────────────
// 「默认关闭」不是一句注释：列出预设必须不产生任何配置写入，只有 POST
// /mcp/servers（桌面端点「启用」）才让 id 出现在 configuredIds 里。
// 若哪天有人把内置预设预置进默认 config，这条会红。

test('tianshu-mcp 默认关闭：列出预设不写 config，configuredIds 不含它', async () => {
  await withTempHome(async () => {
    const routes = buildMcpRoutes(() => null, 'secret-token')
    const res = await routes['GET /mcp/presets']!({}, undefined, { authorization: 'Bearer secret-token' }, undefined)
    assert.equal(res.status, 200)
    const body = res.body as { presets: Array<{ id: string }>; configuredIds: string[] }
    assert.ok(body.presets.some((p) => p.id === 'tianshu-mcp'), '预设目录里必须有它')
    assert.ok(!body.configuredIds.includes('tianshu-mcp'), '列出预设不得把它标成已配置')

    const { loadConfig } = await import('../../config/manager.js')
    assert.equal(
      loadConfig().mcp.servers['tianshu-mcp'],
      undefined,
      '默认关闭：不得预置进 mcp.servers（否则开箱即拉起子进程）',
    )
  })
})

test('显式开启：POST /mcp/servers 之后 id 才出现在 configuredIds', async () => {
  await withTempHome(async () => {
    const routes = buildMcpRoutes(() => null, 'secret-token')
    const preset = findMcpPreset('tianshu-mcp')!
    const post = await routes['POST /mcp/servers']!(
      { serverId: preset.id, command: preset.command, args: preset.args },
      undefined,
      { authorization: 'Bearer secret-token' },
      undefined,
    )
    assert.equal(post.status, 200)

    const res = await routes['GET /mcp/presets']!({}, undefined, { authorization: 'Bearer secret-token' }, undefined)
    const body = res.body as { configuredIds: string[] }
    assert.ok(body.configuredIds.includes('tianshu-mcp'), '启用后应标记为已配置')
  })
})

test('GET /mcp/presets returns presets + configuredIds (auth-gated)', async () => {
  const routes = buildMcpRoutes(() => null, 'secret-token')
  const handler = routes['GET /mcp/presets']!

  const unauthorized = await handler({}, undefined, {}, undefined)
  assert.equal(unauthorized.status, 401)

  const res = await handler({}, undefined, { authorization: 'Bearer secret-token' }, undefined)
  assert.equal(res.status, 200)
  const body = res.body as { presets: unknown[]; configuredIds: unknown }
  assert.ok(Array.isArray(body.presets))
  assert.equal(body.presets.length, MCP_PRESETS.length)
  assert.ok(Array.isArray(body.configuredIds))
})

// ── live 联调：预设声明的 command/args 能不能真拉起上游 ──────────────────
// 默认跳过（联网 + npx 首次拉包约 10s），CI 不依赖网络。复核时显式开启：
//   RIVET_MCP_LIVE=1 npm exec -- tsx --test src/server/__tests__/mcp-presets.test.ts
//
// 这条同时是 expectedTools 的真判据：卡片把它当「示例」呈现而非穷尽清单，
// 但示例里写的名字必须真在上游工具面上——否则用户照着名字等工具，等不到。
const liveGate = process.env.RIVET_MCP_LIVE === '1'

test(
  'live: tianshu-mcp 预设可真实握手，且上游工具面覆盖 expectedTools 声明的名字',
  { skip: liveGate ? false : '联网 + 拉包测试；设 RIVET_MCP_LIVE=1 显式开启' },
  async () => {
    const preset = findMcpPreset('tianshu-mcp')
    assert.ok(preset?.command, '预设必须带 stdio 启动命令')
    const res = await createTransport(
      { command: preset.command, args: preset.args ?? [] },
      { timeoutMs: 90_000 },
    )
    try {
      const listed = await res.client.listTools()
      const names = listed.tools.map((t) => t.name)
      for (const expected of preset.expectedTools ?? []) {
        assert.ok(names.includes(expected), `上游应暴露 ${expected}；实际：${names.join(', ')}`)
      }
    } finally {
      await res.client.close().catch(() => {})
    }
  },
)
