import { after, describe, it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import dns from 'node:dns/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import undici from 'undici'
import type { PinnedLookup } from '../../../tools/net/http-fetch.js'
import { TokenStore } from '../../../auth/token-store.js'
import type { McpOAuthProvider } from '../types.js'

const testDir = mkdtempSync(join(tmpdir(), 'mcp-oauth-security-'))
process.env.RIVET_HOME = testDir
const portProbe = createServer()
await new Promise<void>(resolve => portProbe.listen(0, '127.0.0.1', resolve))
const address = portProbe.address()
assert.ok(address && typeof address !== 'string')
process.env.RIVET_OAUTH_PORT = String(address.port)
await new Promise<void>((resolve, reject) => portProbe.close(err => err ? reject(err) : resolve()))
const { getMcpAccessToken, startMcpOAuth, serveCallback } = await import('../connector.js')
const callbackFetch = globalThis.fetch

/** 与 connector.ts 的 MAX_TOKEN_RESPONSE_BYTES 对齐；独立声明，不从实现导出内部常量。 */
const TOKEN_RESPONSE_LIMIT_BYTES = 64 * 1024

// 凭据路径经 resolveProxyForUrl 读 HTTPS_PROXY/HTTP_PROXY 与 OS 系统代理
// （macOS scutil / Windows 注册表）。本机开着 Clash 之类系统代理时 dispatcher 会
// 变成 ProxyAgent、pin 断言随即假红——文件级把代理面钉成「确定直连」，需要
// 代理的用例自己临时开。
const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'ALL_PROXY', 'all_proxy'] as const
const savedProxyEnv = new Map<string, string | undefined>()
for (const key of PROXY_ENV_KEYS) {
  savedProxyEnv.set(key, process.env[key])
  delete process.env[key]
}
const savedNoSystemProxy = process.env.RIVET_NO_SYSTEM_PROXY
process.env.RIVET_NO_SYSTEM_PROXY = '1'

after(() => {
  rmSync(testDir, { recursive: true, force: true })
  for (const [key, value] of savedProxyEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (savedNoSystemProxy === undefined) delete process.env.RIVET_NO_SYSTEM_PROXY
  else process.env.RIVET_NO_SYSTEM_PROXY = savedNoSystemProxy
})

type Flow = 'exchange' | 'refresh'
let nextServerId = 0

function setup(t: TestContext, endpoint: string, resolvedAddress = '93.184.216.34') {
  const requests: Array<{ url: string; init: undici.RequestInit | undefined }> = []
  const lookup = t.mock.method(dns, 'lookup', async () => ({
    address: resolvedAddress,
    family: resolvedAddress.includes(':') ? 6 : 4,
  }))
  const respond = async (url: string | URL | Request, init?: undici.RequestInit) => {
    requests.push({ url: String(url), init })
    return new undici.Response(JSON.stringify({ access_token: 'fixture-access', expires_in: 3600 }))
  }
  // Both transports are intercepted so a regression cannot send fixture credentials.
  t.mock.method(globalThis, 'fetch', respond)
  t.mock.method(undici, 'fetch', respond)
  const provider: McpOAuthProvider = {
    id: 'fixture', name: 'Fixture', authorizeUrl: 'https://provider.example/authorize',
    tokenEndpoint: endpoint, defaultScopes: [], clientIdHelp: '',
  }
  const run = async (flow: Flow): Promise<unknown> => {
    const id = `${flow}-${++nextServerId}`
    if (flow === 'refresh') {
      new TokenStore(join(testDir, 'mcp-oauth'), id).save({
        accessToken: 'fixture-expired', refreshToken: 'fixture-refresh', expiresAt: 0,
      })
      return getMcpAccessToken(id, provider, 'fixture-client')
    }
    let callback: Promise<Response> | undefined
    t.mock.method(process.stderr, 'write', (chunk: string | Uint8Array) => {
      const text = String(chunk)
      if (text.startsWith('Open this URL to connect MCP:\n')) {
        const auth = new URL(text.trim().split('\n')[1]!)
        const redirect = new URL(auth.searchParams.get('redirect_uri')!)
        redirect.searchParams.set('state', auth.searchParams.get('state')!)
        redirect.searchParams.set('code', 'fixture-code')
        callback = callbackFetch(redirect)
      }
      return true
    })
    try { return await startMcpOAuth(id, provider, 'fixture-client') }
    finally { await callback }
  }
  return { requests, lookup, run }
}

for (const flow of ['exchange', 'refresh'] as const) {
  describe(`${flow} token endpoint security`, () => {
    for (const [endpoint, ip] of [
      ['http://localhost/token', '127.0.0.1'],
      ['http://127.0.0.1/token', '127.0.0.1'],
      ['http://[::1]/token', '::1'],
      ['http://169.254.169.254/token', '169.254.169.254'],
      ['https://provider.example/token', '10.0.0.1'],
      ['http://[::ffff:127.0.0.1]/token', '::ffff:127.0.0.1'],
    ]) {
      it(`blocks ${endpoint} resolving to ${ip} before sending credentials`, async t => {
        const fixture = setup(t, endpoint!, ip!)
        await assert.rejects(() => fixture.run(flow), /private|reserved|denied/i)
        assert.equal(fixture.requests.length, 0)
      })
    }

    it('fails closed when DNS lookup fails', async t => {
      const fixture = setup(t, 'https://unresolved.example/token')
      fixture.lookup.mock.mockImplementation(async () => { throw new Error('fixture DNS failure') })
      await assert.rejects(() => fixture.run(flow), /fixture DNS failure/)
      assert.equal(fixture.requests.length, 0)
    })

    it('applies the OAuth deadline while DNS is still pending', async t => {
      const fixture = setup(t, 'https://unresolved.example/token')
      fixture.lookup.mock.mockImplementation(() => new Promise<never>(() => {}))
      const deadline = new AbortController()
      const expired = new Error('fixture OAuth deadline')
      t.mock.method(AbortSignal, 'timeout', () => {
        queueMicrotask(() => deadline.abort(expired))
        return deadline.signal
      })
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const outcome = await Promise.race([
          fixture.run(flow).then(() => 'unexpected success', error => error),
          new Promise(resolve => { timer = setTimeout(() => resolve('still waiting for DNS'), 500) }),
        ])
        assert.equal(outcome, expired)
        assert.equal(fixture.requests.length, 0)
      } finally { clearTimeout(timer) }
    })

    it('rejects non-HTTP endpoints before sending credentials', async t => {
      const fixture = setup(t, 'file:///tmp/oauth-token')
      await assert.rejects(() => fixture.run(flow), /protocol/i)
      assert.equal(fixture.requests.length, 0)
    })

    it('sends a form POST to a public endpoint with redirects disabled', async t => {
      const fixture = setup(t, 'https://provider.example/token')
      const value = await fixture.run(flow)
      assert.equal(flow === 'refresh' ? value : (value as { accessToken: string }).accessToken, 'fixture-access')
      assert.equal(fixture.requests.length, 1)
      const request = fixture.requests[0]!
      assert.equal(request.init?.method, 'POST')
      assert.equal(request.init?.redirect, 'error')
      const body = new URLSearchParams(String(request.init?.body))
      assert.equal(body.get('grant_type'), flow === 'refresh' ? 'refresh_token' : 'authorization_code')
      assert.equal(body.get('client_id'), 'fixture-client')
      assert.equal(body.get(flow === 'refresh' ? 'refresh_token' : 'code'), flow === 'refresh' ? 'fixture-refresh' : 'fixture-code')
    })

    it('pins the socket lookup to the checked address even when web-fetch pinning is disabled', async t => {
      const previous = process.env.RIVET_FETCH_PIN
      process.env.RIVET_FETCH_PIN = '0'
      t.after(() => {
        if (previous === undefined) delete process.env.RIVET_FETCH_PIN
        else process.env.RIVET_FETCH_PIN = previous
      })
      const fixture = setup(t, 'https://rebind.example/token')
      let agentOptions: undici.Agent.Options | undefined
      const RealAgent = undici.Agent
      t.mock.method(undici, 'Agent', function (options: undici.Agent.Options) {
        agentOptions = options
        return new RealAgent(options)
      })
      await fixture.run(flow)
      // The attacker changes DNS after preflight. The connection's resolver must
      // still return the originally checked address without resolving it again.
      fixture.lookup.mock.mockImplementation(async () => ({ address: '127.0.0.1', family: 4 }))
      const connect = agentOptions?.connect
      assert.ok(connect && typeof connect === 'object')
      const lookup = (connect as { lookup?: PinnedLookup }).lookup
      assert.equal(typeof lookup, 'function')
      const pinned = await new Promise<string>((resolve, reject) => {
        lookup!('rebind.example', {}, (err, address) => {
          if (err) reject(err)
          else resolve(address as string)
        })
      })
      assert.equal(pinned, '93.184.216.34')
      assert.equal(fixture.lookup.mock.callCount(), 1)
    })

    it('releases the pinned dispatcher when reading the token response fails', async t => {
      const fixture = setup(t, 'https://provider.example/token')
      let dispatcher: undici.Dispatcher | undefined
      t.mock.method(undici, 'fetch', async (_url: Parameters<typeof undici.fetch>[0], init?: undici.RequestInit) => {
        dispatcher = init?.dispatcher
        return new undici.Response(new ReadableStream({
          start(controller) { controller.error(new Error('fixture body failure')) },
        }))
      })
      await assert.rejects(() => fixture.run(flow), /fixture body failure/)
      assert.ok(dispatcher instanceof undici.Agent)
      assert.equal(dispatcher.destroyed, true)
    })

    it('routes the credential request through the configured proxy instead of pinning', async t => {
      const previous = process.env.HTTPS_PROXY
      process.env.HTTPS_PROXY = 'http://proxy.example:3128'
      t.after(() => {
        if (previous === undefined) delete process.env.HTTPS_PROXY
        else process.env.HTTPS_PROXY = previous
      })
      const fixture = setup(t, 'https://provider.example/token')
      const proxied: string[] = []
      const RealProxyAgent = undici.ProxyAgent
      const RealAgent = undici.Agent
      let agentConstructed = false
      t.mock.method(undici, 'ProxyAgent', function (options: { uri: string }) {
        proxied.push(options.uri)
        return new RealProxyAgent(options)
      })
      t.mock.method(undici, 'Agent', function (options: undici.Agent.Options) {
        agentConstructed = true
        return new RealAgent(options)
      })

      await fixture.run(flow)

      assert.deepEqual(proxied, ['http://proxy.example:3128'])
      assert.equal(agentConstructed, false, 'a proxied credential request must not also pin a direct socket')
      assert.equal(fixture.requests.length, 1)
    })

    it('still refuses a private token endpoint when a proxy is configured', async t => {
      const previous = process.env.HTTPS_PROXY
      process.env.HTTPS_PROXY = 'http://proxy.example:3128'
      t.after(() => {
        if (previous === undefined) delete process.env.HTTPS_PROXY
        else process.env.HTTPS_PROXY = previous
      })
      // 代理模式下 pin 无法施加（隧道路径由代理解析），预检是唯一一道闸——它不能松。
      const fixture = setup(t, 'https://rebind.example/token', '169.254.169.254')

      await assert.rejects(() => fixture.run(flow), /private|reserved|denied/i)
      assert.equal(fixture.requests.length, 0)
    })

    it('rejects a token response that declares an oversized content-length', async t => {
      const fixture = setup(t, 'https://provider.example/token')
      let dispatcher: undici.Dispatcher | undefined
      t.mock.method(undici, 'fetch', async (_url: Parameters<typeof undici.fetch>[0], init?: undici.RequestInit) => {
        dispatcher = init?.dispatcher
        // 声明 65537 字节、实际正文只有 10 字节：只有 content-length 预检能拦下它，
        // 流式累计（10 < 64 KiB）会放行——这条用例才真正锁住预检分支。
        return new undici.Response('y'.repeat(10), {
          headers: { 'content-length': String(TOKEN_RESPONSE_LIMIT_BYTES + 1) },
        })
      })

      await assert.rejects(() => fixture.run(flow), /declares 65537 bytes, over the 65536-byte limit/)
      assert.ok(dispatcher instanceof undici.Agent)
      assert.equal(dispatcher.destroyed, true)
    })

    it('rejects an oversized chunked token response with no content-length', async t => {
      const fixture = setup(t, 'https://provider.example/token')
      t.mock.method(undici, 'fetch', async () => {
        const response = new undici.Response(new ReadableStream({
          start(controller) {
            for (let i = 0; i < 8; i++) controller.enqueue(new Uint8Array(16 * 1024))
            controller.close()
          },
        }))
        // 前置断言：本用例必须走在流式分支上。undici 对字符串 body 不设 content-length，
        // 一旦这里有了值，用例就会退化成预检用例的副本而无人察觉。
        assert.equal(response.headers.get('content-length'), null)
        return response
      })

      await assert.rejects(() => fixture.run(flow), /exceeds 65536 bytes/)
    })

    it('applies the OAuth deadline while the response body is being read', async t => {
      const fixture = setup(t, 'https://provider.example/token')
      const deadline = new AbortController()
      const expired = new Error('fixture OAuth deadline')
      t.mock.method(AbortSignal, 'timeout', () => deadline.signal)
      t.mock.method(undici, 'fetch', async (_url: Parameters<typeof undici.fetch>[0], init?: undici.RequestInit) => {
        // 正文读到一半挂起：只有 signal 确实被传进 fetch、且 abort 能传播到 body 流，
        // 这次读取才会结束。传播本身由 undici 保证（探针实测 abort → reader.read()
        // reject），这里以契约形式复现同一路径——防的是 signal 被漏传、或 readBodyCapped
        // 把读取错误吞掉这两类回归。
        const signal = init?.signal
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"access_token":"partial'))
            if (signal) signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
          },
        })
        return new undici.Response(stream)
      })
      setTimeout(() => deadline.abort(expired), 20)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const outcome = await Promise.race([
          fixture.run(flow).then(() => 'unexpected success', error => error),
          new Promise(resolve => { timer = setTimeout(() => resolve('still reading — signal never reached the body'), 500) }),
        ])
        assert.equal(outcome, expired)
      } finally { clearTimeout(timer) }
    })
  })
}

// issue #123 修的是 HTML sink 的反射；同一个 provider 原值还会原样进 Error 文案
// 流向终端/TUI，ANSI/C0 控制字符在那条路上才是注入面（审查发现的同源未覆盖面）。
describe('provider error sanitisation across sinks', () => {
  it('strips control characters from the callback page and the rejected error', async () => {
    const port = Number(process.env.RIVET_OAUTH_PORT)
    const state = 'state-sanitise-1'
    const pending = serveCallback(port, state, 'https://example.com/authorize', 5_000)
    pending.catch(() => { /* 本用例只断言净化效果，错误分支的 reject 是预期行为 */ })
    await new Promise(r => setTimeout(r, 200))

    const payload = '\u001b[2J\u001b]0;pwned\u0007<img src=x onerror=alert(1)>'
    const res = await callbackFetch(
      `http://127.0.0.1:${port}/auth/callback?state=${state}&error=${encodeURIComponent(payload)}`,
    )
    const body = await res.text()

    assert.equal(res.status, 400)
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(body), 'HTML sink must not carry raw control characters')
    assert.ok(body.includes('&lt;img'), 'HTML sink must still escape markup')
    assert.ok(body.includes('pwned'), 'the visible part of the error code should survive sanitisation')

    const error = await pending.then(() => null, err => err as Error)
    assert.ok(error instanceof Error)
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(error.message), 'the rejected error must not carry escape sequences')
    assert.ok(error.message.includes('pwned'))
  })

  it('strips control characters from the exchange failure message', async t => {
    // exchange 把 provider 可控文本（error 字段或正文片段）拼进 Error.message，经调用方
    // 展示到终端/TUI——与回调页同一个注入面，必须同用一道净化。
    const fixture = setup(t, 'https://provider.example/token')
    t.mock.method(undici, 'fetch', async () => new undici.Response(
      JSON.stringify({ error: '\u001b[31mfake-provider-error\u001b[0m' }),
      { status: 400 },
    ))

    const error = await fixture.run('exchange').then(() => null, err => err as Error)
    assert.ok(error instanceof Error)
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(error.message), 'the exchange error must not carry escape sequences')
    assert.ok(error.message.includes('fake-provider-error'), 'the visible part of the error should survive sanitisation')
  })
})
