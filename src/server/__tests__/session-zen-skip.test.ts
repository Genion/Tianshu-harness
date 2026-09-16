import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { buildSessionRoutes } from '../session-routes.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'
import type { ServerResponse } from 'node:http'

/**
 * `POST /sessions/:id/zen`（action=skip）——桌面端跳过读专注相位的入口
 * （TUI 侧等价物是 `/fast`，桌面端没有 /fast 故走这条路由）。
 *
 * 钉住三件事：① 非法 action 被拒且不落任何状态；② 晋升语义如实报告——真晋升
 * promoted:true，未 arm/已晋升 promoted:false（**不是错误**，前端据此提示而不是
 * 报错）；③ 轻量替身不带 zen 面时不抛错（ManagedAgent 的 optional 口径）。
 */

class NoopAgent implements ManagedAgent {
  run(_p: string, _cb: AgentCallbacks): Promise<void> { return Promise.resolve() }
  abort(): void {}
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
}

/** 带 zen 面的替身：记录晋升原因，并像真控制器一样单向翻相位。 */
class ZenStubAgent extends NoopAgent {
  promotedReason: string | null = null
  phase: 'zen' | 'full' = 'zen'
  readonly zenController: {
    readonly currentPhase: 'zen' | 'full'
    snapshot(): { zenStats: { zenTurns: number } }
  }

  constructor(zenTurns = 4) {
    super()
    const self = this
    this.zenController = {
      get currentPhase(): 'zen' | 'full' { return self.phase },
      snapshot: () => ({ zenStats: { zenTurns } }),
    }
  }

  promoteZen(reason: 'tool' | 'timeout' | 'triage' | 'user'): boolean {
    this.promotedReason = reason
    if (this.phase !== 'zen') return false
    this.phase = 'full'
    return true
  }
}

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

function mockRes(): ServerResponse {
  return { writeHead() {}, flushHeaders() {}, write() { return true }, end() {}, on() {}, writableEnded: false } as unknown as ServerResponse
}

async function post(
  routes: ReturnType<typeof buildSessionRoutes>,
  body: unknown,
  params: Record<string, string>,
  headers: Record<string, string> = AUTH,
): Promise<{ status: number; body: unknown }> {
  const handler = routes['POST /sessions/:id/zen']!
  const res = await handler(body as never, params, headers, mockRes())
  return res as { status: number; body: unknown }
}

test('POST /sessions/:id/zen：真晋升 → promoted:true、phase 翻 full、zenTurns 透传', async () => {
  const stub = new ZenStubAgent(4)
  const mgr = new RuntimeSessionManager({ createAgent: () => stub })
  const { id } = mgr.createSession({})
  const res = await post(buildSessionRoutes(mgr, TOKEN), { action: 'skip' }, { id })

  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { id, promoted: true, phase: 'full', zenTurns: 4 })
  assert.equal(stub.promotedReason, 'user', '用户主动跳过 → reason 是 user（与 /fast 同一条）')
  assert.equal(stub.phase, 'full')
})

test('POST /sessions/:id/zen：已晋升（未 arm / 已 full）→ promoted:false 而非报错', async () => {
  const stub = new ZenStubAgent(0)
  stub.phase = 'full'
  const mgr = new RuntimeSessionManager({ createAgent: () => stub })
  const { id } = mgr.createSession({})
  const res = await post(buildSessionRoutes(mgr, TOKEN), { action: 'skip' }, { id })

  assert.equal(res.status, 200, '没有相位可跳过不是客户端错误')
  assert.deepEqual(res.body, { id, promoted: false, phase: 'full', zenTurns: 0 })
})

test('POST /sessions/:id/zen：替身不带 zen 面 → 不抛错，如实报 promoted:false / full', async () => {
  const mgr = new RuntimeSessionManager({ createAgent: () => new NoopAgent() })
  const { id } = mgr.createSession({})
  const res = await post(buildSessionRoutes(mgr, TOKEN), { action: 'skip' }, { id })

  assert.equal(res.status, 200)
  assert.deepEqual(res.body, { id, promoted: false, phase: 'full', zenTurns: 0 })
})

test('POST /sessions/:id/zen：action 缺失或非法 → 400（不静默当 skip）', async () => {
  const stub = new ZenStubAgent()
  const mgr = new RuntimeSessionManager({ createAgent: () => stub })
  const { id } = mgr.createSession({})
  const routes = buildSessionRoutes(mgr, TOKEN)

  for (const body of [{}, { action: 'promote' }, { action: true }]) {
    const res = await post(routes, body, { id })
    assert.equal(res.status, 400, `body=${JSON.stringify(body)} 应被拒`)
  }
  assert.equal(stub.promotedReason, null, '被拒的请求不得触碰相位')
  assert.equal(stub.phase, 'zen', '相位保持原样')
})

test('POST /sessions/:id/zen：未知会话 → 404', async () => {
  const mgr = new RuntimeSessionManager({ createAgent: () => new ZenStubAgent() })
  const res = await post(buildSessionRoutes(mgr, TOKEN), { action: 'skip' }, { id: 'no-such-session' })
  assert.equal(res.status, 404)
})

test('POST /sessions/:id/zen：未授权 → 401', async () => {
  const mgr = new RuntimeSessionManager({ createAgent: () => new ZenStubAgent() })
  const { id } = mgr.createSession({})
  const res = await post(buildSessionRoutes(mgr, TOKEN), { action: 'skip' }, { id }, {})
  assert.equal(res.status, 401)
})
