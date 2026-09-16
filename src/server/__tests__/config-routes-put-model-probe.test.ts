import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter } from '../index.js'
import { buildConfigRoutes } from '../config-routes.js'

// 复现探针：PUT /keys/:keyId/models/:modelId 缺 model 键时
// parsed.models[0]! 非空断言抛 TypeError（未捕获 → 请求挂死而非 400）。
const TOKEN = 't'
const AUTH = { authorization: `Bearer ${TOKEN}` }

describe('PUT /keys/:keyId/models/:modelId — 缺 model 键的健壮性', () => {
  const prevHome = process.env.RIVET_HOME
  let home: string

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'rivet-put-probe-'))
    process.env.RIVET_HOME = home
    rmSync(join(home, 'provider-keys.json'), { force: true })
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      provider: {
        default: 'ov',
        providers: {
          ov: {
            name: 'ov',
            baseUrl: 'http://127.0.0.1:1/v1',
            keys: [{ id: 'k1', apiKey: 'sk-1', models: [{ id: 'm1', contextWindow: 128000, maxTokens: 32768 }] }],
            models: [],
          },
        },
      },
    }, null, 2) + '\n')
  })

  after(() => {
    if (prevHome === undefined) delete process.env.RIVET_HOME
    else process.env.RIVET_HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it('missing model key in body → 400 (not a hung TypeError)', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('PUT', '/config/providers/ov/keys/k1/models/m1', {}, AUTH)
    assert.equal(res.status, 400, `expected 400, got ${res.status}`)
    assert.match((res.body as { error: string }).error, /model/)
  })

  it('empty model object → 400 (not a hung TypeError)', async () => {
    const router = createRouter(buildConfigRoutes(TOKEN))
    const res = await router('PUT', '/config/providers/ov/keys/k1/models/m1', { model: null }, AUTH)
    assert.equal(res.status, 400, `expected 400, got ${res.status}`)
  })
})
