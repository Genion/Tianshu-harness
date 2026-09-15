/**
 * 账号路由契约（桌面端账号页经 sidecar 走 device flow）。
 *
 * 本测试锁住四件容易做错、且错了不会自己报错的事：
 *  1. **凭据不出 sidecar** —— poll 成功时 accessToken 落盘，但绝不回传 WebView。
 *     回传了也能跑通（页面照样显示已登录），代价是 Supabase session 进了
 *     渲染进程内存与 devtools，且前端与 CLI 出现两份真值。
 *  2. **轮询是单次 check**，不是 5 分钟长循环 —— 前端 rivetFetch 默认 15s 超时
 *     会把长循环切断（desktop/src/runtime/client.ts 的超时注释）。
 *  3. **登出只清 account.json**，不碰 provider 凭据 —— TokenStore 按 provider
 *     名分文件，登出顺手清掉用户的 codex 登录是真实可能犯的错。
 *  4. **`approved` 却缺 accessToken 视为异常**而非「成功但空」—— 否则空凭据
 *     落盘，用户下次启动发现自己「已登录」但什么都做不了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRouter } from '../index.js'
import { buildAccountRoutes, type AccountApi } from '../account-routes.js'
import { TokenStore } from '../../auth/token-store.js'
import type { DeviceCreateResult, DevicePollResult } from '../../auth/account.js'

const TOKEN = 'tok'
const AUTH = { authorization: `Bearer ${TOKEN}` }

const DEVICE: DeviceCreateResult = {
  deviceCode: 'dc-1',
  userCode: 'UC-1234',
  verifyUrl: 'https://tianshuharness.com/auth/device?code=UC-1234',
  expiresIn: 300,
  pollInterval: 5,
}

/** 每个用例一个临时 RIVET_HOME —— 落盘断言读的是真实磁盘，不是桩的内存。 */
function makeHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'rivet-account-routes-'))
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

/**
 * 默认桩：网络面全假，落盘面用**真实** TokenStore/saveAccountToken
 * （只有真实落盘才能验证「凭据进文件、不进响应体」这条不变量）。
 */
function stubApi(over: Partial<AccountApi> = {}): AccountApi {
  return {
    requestDeviceCode: async () => DEVICE,
    checkDeviceOnce: async () => ({ status: 'pending' }),
    fetchAccountProfile: async () => null,
    accountStore: (home) => new TokenStore(home, 'account'),
    saveAccountToken: (store, poll) => {
      if (!poll.accessToken) throw new Error('saveAccountToken: missing accessToken')
      const data = {
        accessToken: poll.accessToken,
        refreshToken: poll.refreshToken,
        expiresAt: Date.now() + (poll.expiresIn ?? 3600) * 1000,
      }
      store.save(data)
      return data
    },
    ...over,
  }
}

function routerFor(home: string, over: Partial<AccountApi> = {}) {
  return createRouter(buildAccountRoutes({ apiToken: TOKEN, account: stubApi(over), rivetHome: home }))
}

test('所有账号路由都要 Bearer token——缺 token 一律 401', async () => {
  const { home, cleanup } = makeHome()
  try {
    const router = routerFor(home)
    for (const [method, path] of [
      ['POST', '/account/device'],
      ['POST', '/account/poll'],
      ['GET', '/account/status'],
      ['POST', '/account/logout'],
    ] as const) {
      const res = await router(method, path, {}, {})
      assert.equal(res.status, 401, `${method} ${path} 未鉴权`)
    }
  } finally {
    cleanup()
  }
})

test('POST /account/device 透传 userCode/verifyUrl/deviceCode 并带上设备名', async () => {
  const { home, cleanup } = makeHome()
  try {
    let seen: Record<string, unknown> | undefined
    const router = routerFor(home, {
      requestDeviceCode: async (opts) => {
        seen = opts as Record<string, unknown>
        return DEVICE
      },
    })
    const res = await router('POST', '/account/device', { deviceName: 'probe-host' }, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as DeviceCreateResult
    assert.equal(body.userCode, 'UC-1234')
    assert.equal(body.verifyUrl, DEVICE.verifyUrl)
    // deviceCode 是 RFC 8628 里给客户端的轮询凭据，必须回给前端（否则无法 poll）
    assert.equal(body.deviceCode, 'dc-1')
    assert.equal(seen?.deviceName, 'probe-host')
  } finally {
    cleanup()
  }
})

test('POST /account/poll 缺 deviceCode 是 400，不是静默 pending', async () => {
  const { home, cleanup } = makeHome()
  try {
    const router = routerFor(home)
    const res = await router('POST', '/account/poll', {}, AUTH)
    assert.equal(res.status, 400)
  } finally {
    cleanup()
  }
})

test('POST /account/poll 单次 check 后立即返回 pending——不长循环', async () => {
  const { home, cleanup } = makeHome()
  try {
    let calls = 0
    const router = routerFor(home, {
      checkDeviceOnce: async () => {
        calls++
        return { status: 'pending' }
      },
    })
    const started = Date.now()
    const res = await router('POST', '/account/poll', { deviceCode: 'dc-1' }, AUTH)
    assert.equal(res.status, 200)
    assert.equal((res.body as DevicePollResult).status, 'pending')
    assert.equal(calls, 1, '路由必须自己单次 check（前端负责按 pollInterval 重发）')
    assert.ok(Date.now() - started < 1000, '单次 check 不得挂住')
  } finally {
    cleanup()
  }
})

test('POST /account/poll approved：token 落盘但绝不回传 WebView', async () => {
  const { home, cleanup } = makeHome()
  try {
    const router = routerFor(home, {
      checkDeviceOnce: async () => ({
        status: 'approved',
        accessToken: 'AT-SECRET',
        refreshToken: 'RT-SECRET',
        expiresIn: 3600,
      }),
    })
    const res = await router('POST', '/account/poll', { deviceCode: 'dc-1' }, AUTH)
    assert.equal(res.status, 200)
    assert.equal((res.body as DevicePollResult).status, 'approved')

    const serialized = JSON.stringify(res.body)
    assert.ok(!serialized.includes('AT-SECRET'), 'accessToken 不得出现在响应体（凭据不出 sidecar）')
    assert.ok(!serialized.includes('RT-SECRET'), 'refreshToken 不得出现在响应体')

    const saved = new TokenStore(home, 'account').load()
    assert.equal(saved?.accessToken, 'AT-SECRET', 'token 必须落盘，否则 CLI/TUI 读不到这次登录')
  } finally {
    cleanup()
  }
})

test('POST /account/poll pending 时不写盘——空凭据落盘会让下次启动谎报已登录', async () => {
  const { home, cleanup } = makeHome()
  try {
    const router = routerFor(home, { checkDeviceOnce: async () => ({ status: 'pending' }) })
    await router('POST', '/account/poll', { deviceCode: 'dc-1' }, AUTH)
    assert.equal(new TokenStore(home, 'account').load(), null)
  } finally {
    cleanup()
  }
})

test('POST /account/poll approved 却缺 accessToken → 5xx 且不写盘', async () => {
  const { home, cleanup } = makeHome()
  try {
    const router = routerFor(home, { checkDeviceOnce: async () => ({ status: 'approved' }) })
    const res = await router('POST', '/account/poll', { deviceCode: 'dc-1' }, AUTH)
    assert.ok(res.status >= 500, `缺凭据应是异常，得到 ${res.status}`)
    assert.equal(new TokenStore(home, 'account').load(), null)
  } finally {
    cleanup()
  }
})

test('GET /account/status 未登录 → loggedIn:false（不是 500）', async () => {
  const { home, cleanup } = makeHome()
  try {
    const res = await routerFor(home)('GET', '/account/status', {}, AUTH)
    assert.equal(res.status, 200)
    assert.equal((res.body as { loggedIn: boolean }).loggedIn, false)
  } finally {
    cleanup()
  }
})

test('GET /account/status 已登录 → loggedIn:true + 邮箱', async () => {
  const { home, cleanup } = makeHome()
  try {
    new TokenStore(home, 'account').save({
      accessToken: 'AT',
      expiresAt: Date.now() + 3600_000,
    })
    const router = routerFor(home, {
      fetchAccountProfile: async () => ({ email: 'qa-test@tianshuharness.com', userId: 'u-1' }),
    })
    const res = await router('GET', '/account/status', {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { loggedIn: boolean; email: string | null; userId: string | null }
    assert.equal(body.loggedIn, true)
    assert.equal(body.email, 'qa-test@tianshuharness.com')
    assert.equal(body.userId, 'u-1')
  } finally {
    cleanup()
  }
})

test('GET /account/status 拉不到 profile 时降级——离线不等于未登录', async () => {
  const { home, cleanup } = makeHome()
  try {
    new TokenStore(home, 'account').save({ accessToken: 'AT', expiresAt: Date.now() + 3600_000 })
    const router = routerFor(home, {
      fetchAccountProfile: async () => {
        throw new Error('network down')
      },
    })
    const res = await router('GET', '/account/status', {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { loggedIn: boolean; email: string | null }
    assert.equal(body.loggedIn, true)
    assert.equal(body.email, null)
  } finally {
    cleanup()
  }
})

test('POST /account/logout 清账号凭据，但不碰 provider 凭据', async () => {
  const { home, cleanup } = makeHome()
  try {
    new TokenStore(home, 'account').save({ accessToken: 'AT-ACCOUNT', expiresAt: Date.now() + 3600_000 })
    new TokenStore(home, 'codex').save({ accessToken: 'AT-CODEX', expiresAt: Date.now() + 3600_000 })

    const res = await routerFor(home)('POST', '/account/logout', {}, AUTH)
    assert.equal(res.status, 200)

    assert.equal(new TokenStore(home, 'account').load(), null, '登出必须清账号凭据')
    assert.equal(
      new TokenStore(home, 'codex').load()?.accessToken,
      'AT-CODEX',
      '登出天枢账号不得顺手清掉 provider 登录',
    )
  } finally {
    cleanup()
  }
})
