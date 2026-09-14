/**
 * 优雅关停：SSE 长连的主动清场（agent-13 修复）。
 *
 * 病灶（4ec384454 引入，探针实测）：/events 等长连只挂 res.on('close')，
 * 桌面客户端连着时 SIGINT 关停链里的 server.close(cb) 永不回调——只能 kill -9。
 * 修复引入 SseConnectionRegistry（路由层活动连接集合）+ 关停链 closeAll()
 * + closeIdleConnections()（清 res.end 之后转入 keep-alive 空闲态的 socket）。
 *
 * 本文件把两个机制都钉在集成测试里（任缺其一都会红）：
 *   - 活跃 SSE 未清场：server.close(cb) 不回调（挂起同构）；
 *   - 仅 closeAll（done+end）：socket 转空闲但仍在，cb 仍不回调；
 *   - closeAll + closeIdleConnections：cb 及时回调，且客户端先读到 done 帧。
 *
 * 清理纪律：每个用例的断言都在 try 内——任何一步失败（含 RED 期）也必须走
 * finally 断开客户端并关停 server，否则残留连接会拖住 node --test 进程。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { startServer } from '../index.js'
import { ServerEventBus } from '../server-event-bus.js'
import { buildServerEventsRoute } from '../server-events-route.js'
import { SseConnectionRegistry } from '../sse-registry.js'

const TOKEN = 'shutdown-drain-token'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function eventsRoutes(bus: ServerEventBus, registry: SseConnectionRegistry) {
  return {
    ...buildServerEventsRoute(bus, TOKEN, { healthSnapshot: () => ({ ok: true }) as never }, registry),
  }
}

test('SseConnectionRegistry：closeAll 逐个关闭并清空；unregister 幂等', () => {
  const registry = new SseConnectionRegistry()
  const closed: string[] = []
  const a = { close: () => closed.push('a') }
  const b = { close: () => closed.push('b') }
  registry.register(a)
  registry.register(b)
  assert.equal(registry.size, 2)

  registry.unregister(a)
  registry.closeAll()

  assert.deepEqual(closed, ['b'], 'closeAll 只关仍登记在册的连接')
  assert.equal(registry.size, 0)
  registry.closeAll() // 二次调用无操作
  registry.unregister(b) // 注销不存在的连接不抛
  assert.deepEqual(closed, ['b'])
})

test('关停链：closeAll + closeIdleConnections 让 server.close(cb) 及时回调', { timeout: 15_000 }, async () => {
  const bus = new ServerEventBus()
  const registry = new SseConnectionRegistry()
  const server = await startServer(0, eventsRoutes(bus, registry), TOKEN)

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let closed: Promise<void> | undefined
  let cbAt = -1
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/events`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    assert.equal(res.status, 200)
    reader = res.body!.getReader()
    await reader.read() // hello 帧
    assert.equal(registry.size, 1, '建连后连接应登记进注册表')

    const t0 = Date.now()
    closed = new Promise<void>((resolve) => {
      server.close(() => {
        cbAt = Date.now() - t0
        resolve()
      })
    })

    await sleep(500)
    assert.equal(cbAt, -1, '活跃 SSE 未清场时 server.close(cb) 不应回调（修复前的挂起同构）')

    registry.closeAll()
    assert.equal(registry.size, 0, 'closeAll 后注册表应为空')
    await sleep(500)
    assert.equal(cbAt, -1, '仅 done+end 不足：keep-alive 空闲 socket 仍阻塞（需 closeIdleConnections）')

    server.closeIdleConnections()
    await Promise.race([
      closed,
      sleep(1500).then(() => {
        throw new Error(`server.close(cb) 未在 1.5s 内回调——长连仍在阻塞关停（cbAt=${cbAt}）`)
      }),
    ])
    assert.ok(cbAt >= 0 && cbAt < 1500, `cb 应在 1.5s 内触发（实际 ${cbAt}ms）`)
  } finally {
    await reader?.cancel().catch(() => {})
    try { server.closeIdleConnections() } catch { /* RED 期该方法可能尚不存在 */ }
    if (closed) {
      await Promise.race([closed, sleep(1000)])
    } else {
      await Promise.race([new Promise<void>((r) => server.close(() => r())), sleep(500)])
    }
    bus.close()
  }
})

test('closeAll 让客户端先读到 done 帧（再 EOF，走退避重连）', { timeout: 15_000 }, async () => {
  const bus = new ServerEventBus()
  const registry = new SseConnectionRegistry()
  const server = await startServer(0, eventsRoutes(bus, registry), TOKEN)

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/events`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const first = await reader.read()
    if (first.value) text += decoder.decode(first.value)

    assert.equal(registry.size, 1)
    registry.closeAll()

    const deadline = Date.now() + 1500
    while (Date.now() < deadline && !text.includes('event: done')) {
      const chunk = await Promise.race([reader.read(), sleep(200).then(() => null)])
      if (!chunk) continue
      if (chunk.value) text += decoder.decode(chunk.value)
      if (chunk.done) break
    }
    assert.ok(text.includes('event: done'), `客户端应读到 done 帧（实际尾部: ${text.slice(-200)}）`)
  } finally {
    await reader?.cancel().catch(() => {})
    try { server.closeIdleConnections() } catch { /* RED 期该方法可能尚不存在 */ }
    await Promise.race([new Promise<void>((r) => server.close(() => r())), sleep(1000)])
    bus.close()
  }
})

// ── serve.ts 接线契约（runServe 集成太重，用源码断言钉住关停链）────────────
// 集成测试覆盖的是机制（registry/closeIdleConnections），但机制「有没有被
// finish 链调用」只有 serve.ts 的接线知道——这里照 serve-agent-gate-wiring
// 的先例做源码级契约，防未来重构悄悄摘掉调用点。
test('serve.ts close 链接线：closeAll、closeIdleConnections、保险丝三件套齐备', () => {
  const source = readFileSync(new URL('../serve.ts', import.meta.url), 'utf8')
  assert.match(source, /sseRegistry\.closeAll\(\)/, 'finish 链必须 closeAll——否则长连阻塞关停（agent-13）')
  assert.match(source, /server\.closeIdleConnections\(\)/, 'close 后必须清空闲连接——否则每次退出多等 5s keepAliveTimeout')
  assert.match(source, /graceful shutdown did not finish in 15s/, 'SIGINT 保险丝必须存在——兜底任何未预料的悬挂（预算对齐设计内慢收尾，不切尾写）')
  assert.match(source, /second signal — forcing immediate exit/, '二次信号必须立即强退（CLI 惯例；幂等守卫同时保证保险丝只武装一次）')
})
