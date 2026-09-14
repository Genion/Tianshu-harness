import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RuntimeSessionManager,
  type ManagedAgent,
} from '../session-manager.js'
import { buildSessionRoutes } from '../session-routes.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'
import type { ServerResponse } from 'node:http'

/**
 * 禅相位建连快照（zen_phase 合成事件）——与 job_snapshot 同构的第三条 seq=0
 * 元事件，起因不同：
 *
 * `zen_phase` 是**边沿事件**（只在 run 起点 arm 与每次晋升时发），不像 phase /
 * tool_result 那样在每轮里反复出现。因此它有两个天然缺口：
 *   ① 长会话里这条事件早已滑出 /stream 的回放窗口；
 *   ② 重连走 `?since=store.seq` 续读，不会重放窗口内的旧帧。
 * 两条叠加的结果就是「切走再切回，相位徽章必然丢失，要等下一次 run 才回来」。
 *
 * 解法是把当前相位挂到 SessionRecord 上（onZenPhaseChange 同步 + 落 index.json，
 * sidecar 重启后经 rehydrate 的 `...rec` 恢复），建连时按它补发一条。
 *
 * 桌面端 hub 拦截该 seq=0 帧，经独立 action 直接派发（见 session-event-hub.ts /
 * event-reducer.ts 的 zen_snapshot）。
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

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

function mockRes() {
  const writes: string[] = []
  let corked = false
  const corkBuffer: string[] = []
  const res = {
    writeHead() {},
    flushHeaders() {},
    write(chunk: string) {
      if (corked) corkBuffer.push(chunk)
      else writes.push(chunk)
      return true
    },
    end() {},
    cork() { corked = true },
    uncork() {
      corked = false
      if (corkBuffer.length > 0) {
        writes.push(corkBuffer.join(''))
        corkBuffer.length = 0
      }
    },
    on() {},
    writableEnded: false,
  }
  return { res: res as unknown as ServerResponse, writes }
}

function parseFrames(writes: string[]): Array<{ event: string; payload: { seq: number; type: string; data: Record<string, unknown> } }> {
  return writes
    .join('')
    .split('\n\n')
    .map((f) => f.trim())
    .filter((f) => f.startsWith('event: '))
    .map((f) => ({
      event: f.slice(7, f.indexOf('\n')),
      payload: JSON.parse(f.slice(f.indexOf('data: ') + 6)) as { seq: number; type: string; data: Record<string, unknown> },
    }))
}

/** 会话内部槽位（与 session-manager 的 InternalSession 同形的最小投影）。 */
type SessionSlots = { sessions: Map<string, { record: { zenPhaseMirror?: unknown } }> }

test('GET /stream：从未收到相位变化的会话不发 zen_phase——不伪造默认相位', async () => {
  const mgr = new RuntimeSessionManager({ createAgent: () => new NoopAgent() })
  const { id } = mgr.createSession({})
  const routes = buildSessionRoutes(mgr, TOKEN)
  const { res, writes } = mockRes()
  await routes['GET /sessions/:id/stream']!({}, { id, since: '0' }, AUTH, res)

  const frames = parseFrames(writes)
  // 关键反面：若这里补发一条合成的 full/未 armed，客户端会把「禅未启用」当成
  // 事实写进状态——而它其实只是「服务端还不知道」。缺省必须保持缺省。
  assert.equal(
    frames.find((f) => f.event === 'zen_phase'),
    undefined,
    '无镜像必须静默（禅未启用的会话不该凭空出现相位徽章）',
  )
  assert.equal(frames[0]?.event, 'replay_window', '首帧仍是 replay_window')
  assert.equal(frames[1]?.event, 'job_snapshot', '次帧仍是 job_snapshot')
})

test('GET /stream：有相位镜像时补发 zen_phase（seq=0，载荷逐字透传，帧序在回放主体之前）', async () => {
  const mgr = new RuntimeSessionManager({ createAgent: () => new NoopAgent() })
  const { id } = mgr.createSession({})
  const mirror = { phase: 'zen', armed: true, zenTurns: 3 }
  ;(mgr as unknown as { getZenPhaseMirror: (sessionId: string) => unknown }).getZenPhaseMirror = () => mirror

  const routes = buildSessionRoutes(mgr, TOKEN)
  const { res, writes } = mockRes()
  await routes['GET /sessions/:id/stream']!({}, { id, since: '0' }, AUTH, res)

  const frames = parseFrames(writes)
  const frame = frames.find((f) => f.event === 'zen_phase')
  assert.ok(frame, '必须发出 zen_phase 帧')
  assert.equal(frame!.payload.seq, 0, '合成事件 seq 恒为 0（不得推进客户端水位）')
  assert.equal(frame!.payload.type, 'zen_phase')
  assert.deepEqual(frame!.payload.data, mirror, '镜像逐字透传，路由不重算不解码')
  // 帧序必须与另两条 seq=0 元事件一致：都在回放主体之前——否则客户端会在
  // 折叠完历史事件之后才收到快照，相位被历史里更早的 zen_phase 覆盖。
  assert.deepEqual(frames.map((f) => f.event), ['replay_window', 'job_snapshot', 'zen_phase'])
})

test('getZenPhaseMirror：读会话 record 上的镜像；未知会话/新会话都是 undefined', () => {
  const mgr = new RuntimeSessionManager({ createAgent: () => new NoopAgent() })
  const { id } = mgr.createSession({})

  assert.equal(mgr.getZenPhaseMirror(id), undefined, '新会话无镜像是 undefined，不是空对象')

  const mirror = { phase: 'full', reason: 'tool', armed: true, zenTurns: 1 }
  ;(mgr as unknown as SessionSlots).sessions.get(id)!.record.zenPhaseMirror = mirror
  assert.deepEqual(mgr.getZenPhaseMirror(id), mirror, '镜像随 record 走（rehydrate 经 ...rec 恢复）')

  assert.equal(mgr.getZenPhaseMirror('no-such-session'), undefined)
})
