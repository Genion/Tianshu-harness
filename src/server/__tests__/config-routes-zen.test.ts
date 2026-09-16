/**
 * /config/zen — 禅模式开关路由（用户显式 opt-in）。
 *
 * 为什么单列一个文件：这条路由是 TUI `/zen on|off` 与桌面端设置开关的共同写入口，
 * 而「默认关」是产品语义——不能被某次 UI 改动顺手翻成默认开。测试钉住三件事：
 * ① 未配置即 false（不是默认开）；② PUT 只动 enabled，既有档位不被抹掉；
 * ③ 非布尔载荷被拒且不落盘（不静默 truthy 化）。
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter } from '../index.js'
import { buildConfigRoutes } from '../config-routes.js'

const TOKEN = 'zen-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

function writeConfig(home: string, config: Record<string, unknown>): void {
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2) + '\n')
}

function readToolsZen(home: string): unknown {
  const raw = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as { tools?: { zen?: unknown } }
  return raw.tools?.zen
}

describe('GET/PUT /config/zen', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string
  let router: ReturnType<typeof createRouter>

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-config-zen-'))
    process.env.RIVET_HOME = home
    router = createRouter(buildConfigRoutes(TOKEN))
  })

  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  beforeEach(() => {
    writeConfig(home, { provider: { default: 'deepseek', providers: {} } })
  })

  it('未配置 zen → enabled:false（默认关，不是默认开）', async () => {
    const res = await router('GET', '/config/zen', {}, AUTH)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { enabled: false })
  })

  it('PUT enabled:true → 落盘 tools.zen.enabled 并可回读', async () => {
    const res = await router('PUT', '/config/zen', { enabled: true }, AUTH)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true, enabled: true })
    assert.deepEqual(readToolsZen(home), { enabled: true })

    const back = await router('GET', '/config/zen', {}, AUTH)
    assert.deepEqual(back.body, { enabled: true })
  })

  it('PUT enabled:false 可关回去（幂等）', async () => {
    await router('PUT', '/config/zen', { enabled: true }, AUTH)
    const res = await router('PUT', '/config/zen', { enabled: false }, AUTH)
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true, enabled: false })
    assert.deepEqual(readToolsZen(home), { enabled: false })
  })

  it('PUT 只动 enabled——既有档位（faceMode/timeoutSteps/triage）不被抹掉', async () => {
    writeConfig(home, {
      provider: { default: 'deepseek', providers: {} },
      tools: { zen: { faceMode: 'structuredRead', timeoutSteps: 3, triage: { enabled: false, maxChars: 40 } } },
    })
    const res = await router('PUT', '/config/zen', { enabled: true }, AUTH)
    assert.equal(res.status, 200)
    assert.deepEqual(readToolsZen(home), {
      faceMode: 'structuredRead',
      timeoutSteps: 3,
      triage: { enabled: false, maxChars: 40 },
      enabled: true,
    })
  })

  it('PUT 非布尔 → 400，且不落盘（不静默 truthy 化）', async () => {
    for (const bad of ['yes', 1, null]) {
      const res = await router('PUT', '/config/zen', { enabled: bad }, AUTH)
      assert.equal(res.status, 400, `enabled=${JSON.stringify(bad)} 应被拒`)
    }
    assert.equal(readToolsZen(home), undefined, '被拒的写入不得落盘')
  })

  it('PUT 缺字段 → 400', async () => {
    const res = await router('PUT', '/config/zen', {}, AUTH)
    assert.equal(res.status, 400)
    assert.equal(readToolsZen(home), undefined)
  })

  it('未授权 → 401', async () => {
    const res = await router('GET', '/config/zen', {}, {})
    assert.equal(res.status, 401)
  })
})
