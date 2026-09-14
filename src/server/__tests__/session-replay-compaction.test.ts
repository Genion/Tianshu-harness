import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RuntimeSessionManager,
  type ManagedAgent,
  type PersistedSession,
  type SessionEvent,
  type SessionPersistenceAdapter,
  type SessionRecord,
} from '../session-manager.js'
import { buildSessionRoutes } from '../session-routes.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'
import type { ServerResponse } from 'node:http'

/**
 * 回放合并接线（桌面性能阶段 1）：三个回放出口——/stream 初始回放、
 * GET /events?since=、GET /events?before=——都经 replay-compaction.ts 投影；
 * 内存环与磁盘不动（gap/live 通道逐条不变）；RIVET_REPLAY_COMPACT=0 关闭。
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

class LazyMemoryPersistence implements SessionPersistenceAdapter {
  records = new Map<string, SessionRecord>()
  events = new Map<string, SessionEvent[]>()
  constructor(seed: PersistedSession[] = []) {
    for (const s of seed) {
      this.records.set(s.record.id, s.record)
      this.events.set(s.record.id, s.events.slice())
    }
  }
  saveRecord(record: SessionRecord): void { this.records.set(record.id, { ...record }) }
  appendEvent(id: string, event: SessionEvent): void {
    const arr = this.events.get(id) ?? []
    arr.push(event)
    this.events.set(id, arr)
  }
  loadAll(): PersistedSession[] {
    return [...this.records.values()].map((r) => ({ record: r, events: this.events.get(r.id) ?? [] }))
  }
  loadRecords(): SessionRecord[] { return [...this.records.values()].map((r) => ({ ...r })) }
  loadEvents(id: string): SessionEvent[] { return (this.events.get(id) ?? []).map((e) => ({ ...e })) }
  loadEventsAsync(id: string): Promise<SessionEvent[]> { return Promise.resolve(this.loadEvents(id)) }
}

function ev(seq: number, type: SessionEvent['type'], data: Record<string, unknown> = {}): SessionEvent {
  return { seq, ts: 100 + seq, type, data }
}

/** 每 turn 16 条：user + 6 thinking + tool_use + tool_result + 6 text + turn_complete。 */
const TURN_LEN = 16
function seedTurnLog(turns: number, opts: { openTail?: boolean } = {}): SessionEvent[] {
  const out: SessionEvent[] = []
  let seq = 0
  for (let t = 1; t <= turns; t++) {
    out.push(ev(++seq, 'user', { text: `q${t}` }))
    for (let i = 0; i < 6; i++) out.push(ev(++seq, 'thinking_delta', { text: `th${t}-${i};` }))
    out.push(ev(++seq, 'tool_use', { id: `tool-${t}`, name: 'read_file', input: { path: `f${t}` } }))
    out.push(ev(++seq, 'tool_result', { id: `tool-${t}`, name: 'read_file', result: 'ok' }))
    for (let i = 0; i < 6; i++) out.push(ev(++seq, 'text_delta', { text: `a${t}-${i};` }))
    if (!(opts.openTail && t === turns)) out.push(ev(++seq, 'turn_complete', { turnNumber: t }))
  }
  return out
}

function makeSeed(events: SessionEvent[], status: SessionRecord['status'] = 'completed'): PersistedSession[] {
  return [{
    record: {
      id: 'long', status, createdAt: 1, updatedAt: 9,
      cwd: '/work', lastSeq: events[events.length - 1]!.seq, pendingApprovals: 0,
    },
    events,
  }]
}

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

function mockRes() {
  const writes: string[] = []
  let corked = false
  let corkBuffer: string[] = []
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
        corkBuffer = []
      }
    },
    on() {},
    writableEnded: false,
  }
  return { res: res as unknown as ServerResponse, writes }
}

function parseFrames(all: string): Array<{ event: string; payload: SessionEvent }> {
  return all
    .split('\n\n')
    .filter((f) => f.startsWith('event: '))
    .map((frame) => {
      const event = frame.slice(7, frame.indexOf('\n'))
      const payload = JSON.parse(frame.slice(frame.indexOf('data: ') + 6)) as SessionEvent
      return { event, payload }
    })
}

async function withCompactEnv<T>(value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const prev = process.env.RIVET_REPLAY_COMPACT
  if (value === undefined) delete process.env.RIVET_REPLAY_COMPACT
  else process.env.RIVET_REPLAY_COMPACT = value
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.RIVET_REPLAY_COMPACT
    else process.env.RIVET_REPLAY_COMPACT = prev
  }
}

test('GET /stream 初始回放：已闭合 delta run 合并，seq 单调、末 seq 不变、边界事件保留', async () => {
  const log = seedTurnLog(10)
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: new LazyMemoryPersistence(makeSeed(log)),
  })
  const routes = buildSessionRoutes(mgr, TOKEN)
  const { res, writes } = mockRes()
  await withCompactEnv(undefined, () => routes['GET /sessions/:id/stream']!({}, { id: 'long', since: '0' }, AUTH, res))

  const frames = parseFrames(writes.join(''))
  assert.equal(frames[0]!.event, 'replay_window', '首帧仍是 replay_window')
  const body = frames.filter((f) => f.payload.seq > 0).map((f) => f.payload)
  // 每 turn 16 条 → 6 条（user、thinking、tool_use、tool_result、text、turn_complete）。
  assert.equal(body.length, 10 * 6, `合并后帧数 ${body.length}`)
  for (let i = 1; i < body.length; i++) assert.ok(body[i]!.seq > body[i - 1]!.seq, 'seq 严格递增')
  assert.equal(body[body.length - 1]!.seq, log.length, '末条 seq = 会话 lastSeq')

  const thinking = body[1]!
  assert.equal(thinking.type, 'thinking_delta')
  assert.equal(thinking.seq, 7, 'seq 取 run 末条')
  assert.equal(thinking.data.streamStartSeq, 2, 'streamStartSeq 取 run 首条')
  assert.equal(thinking.data.streamStartTs, 102)
  assert.equal(thinking.data.text, 'th1-0;th1-1;th1-2;th1-3;th1-4;th1-5;')
  const text = body[4]!
  assert.equal(text.type, 'text_delta')
  assert.equal(text.data.streamStartSeq, 10)
  assert.equal(text.seq, 15)
  assert.deepEqual(body.slice(0, 6).map((e) => e.type), ['user', 'thinking_delta', 'tool_use', 'tool_result', 'text_delta', 'turn_complete'])
})

test('GET /stream：会话仍在流式输出时末段 run 原样保留', async () => {
  // 持久化层里 status=running 的会话在 rehydrate 时会被补 status/error 事件
  // （sidecar 重启对账），所以这里用 ephemeral 会话直接灌内存环模拟「正在流式输出」。
  const log = seedTurnLog(3, { openTail: true })
  const mgr = new RuntimeSessionManager({ createAgent: () => new NoopAgent() })
  const { id } = mgr.createSession({})
  const internal = mgr as unknown as { sessions: Map<string, { events: SessionEvent[]; seq: number }> }
  const s = internal.sessions.get(id)!
  const baseSeq = s.seq
  for (const e of log) {
    s.seq++
    s.events.push({ ...e, seq: s.seq })
  }
  const routes = buildSessionRoutes(mgr, TOKEN)
  const { res, writes } = mockRes()
  await withCompactEnv(undefined, () => routes['GET /sessions/:id/stream']!({}, { id, since: '0' }, AUTH, res))
  const all = parseFrames(writes.join('')).filter((f) => f.payload.seq > 0).map((f) => f.payload)
  const body = all.filter((e) => e.seq > baseSeq)
  // 前两个 turn 各 6 条，末 turn：user、thinking(合并)、tool_use、tool_result + 6 条原样 text_delta。
  assert.equal(body.length, 2 * 6 + 4 + 6)
  const tail = body.slice(-6)
  assert.ok(tail.every((e) => e.type === 'text_delta' && e.data.streamStartSeq === undefined), '末段逐条原样')
  assert.deepEqual(tail.map((e) => e.data.text), ['a3-0;', 'a3-1;', 'a3-2;', 'a3-3;', 'a3-4;', 'a3-5;'])
})

test('GET /events?since= 合并且 lastSeq 不变；since 落在 run 中间只合并未见 chunk', async () => {
  const log = seedTurnLog(2)
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: new LazyMemoryPersistence(makeSeed(log)),
  })
  const routes = buildSessionRoutes(mgr, TOKEN)
  const handler = routes['GET /sessions/:id/events']!

  const full = await withCompactEnv(undefined, () => handler({}, { id: 'long', since: '0' }, AUTH))
  assert.equal(full.status, 200)
  const fullBody = full.body as { events: SessionEvent[]; lastSeq: number }
  assert.equal(fullBody.lastSeq, log.length)
  assert.equal(fullBody.events.length, 2 * 6)

  // since=3：thinking run（seq 2..7）只剩 4..7 → 合并文本只含未见 chunk，起点 4。
  const partial = await withCompactEnv(undefined, () => handler({}, { id: 'long', since: '3' }, AUTH))
  const partialBody = partial.body as { events: SessionEvent[]; lastSeq: number }
  assert.equal(partialBody.lastSeq, log.length)
  const first = partialBody.events[0]!
  assert.equal(first.type, 'thinking_delta')
  assert.equal(first.seq, 7)
  assert.equal(first.data.streamStartSeq, 4)
  assert.equal(first.data.text, 'th1-2;th1-3;th1-4;th1-5;')
  assert.ok(partialBody.events.every((e) => e.seq > 3))
})

test('GET /events?before= 冷页合并（末段亦合并），页首仍对齐 user', async () => {
  const log = seedTurnLog(10)
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: new LazyMemoryPersistence(makeSeed(log)),
    maxEvents: 2 * TURN_LEN, // 环只装尾部两个 turn → floor = 8*16+1 = 129
  })
  const routes = buildSessionRoutes(mgr, TOKEN)
  await mgr.getEventsAsync('long', 0)
  const handler = routes['GET /sessions/:id/events']!
  const page = await withCompactEnv(undefined, () => handler({}, { id: 'long', before: '129', limit: String(2 * TURN_LEN) }, AUTH))
  assert.equal(page.status, 200)
  const body = page.body as { events: SessionEvent[]; firstSeq: number; lastSeq: number }
  assert.equal(body.firstSeq, 1)
  assert.equal(body.lastSeq, log.length)
  assert.equal(body.events[0]!.type, 'user')
  assert.equal(body.events[0]!.seq, 6 * TURN_LEN + 1, '页首 = turn 7 的 user')
  assert.equal(body.events.length, 2 * 6, '两个 turn 各压成 6 条')
  assert.ok(body.events.every((e) => e.seq < 129))
  for (let i = 1; i < body.events.length; i++) assert.ok(body.events[i]!.seq > body.events[i - 1]!.seq)
  // 翻页游标语义不变：下一页 before = 本页 events[0].seq。
  const next = await withCompactEnv(undefined, () => handler({}, { id: 'long', before: String(body.events[0]!.seq), limit: String(TURN_LEN) }, AUTH))
  const nextBody = next.body as { events: SessionEvent[] }
  assert.equal(nextBody.events[0]!.seq, 5 * TURN_LEN + 1)
  assert.equal(nextBody.events[nextBody.events.length - 1]!.seq, 6 * TURN_LEN)
})

test('RIVET_REPLAY_COMPACT=0：三个出口全部回到逐条', async () => {
  const log = seedTurnLog(4)
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: new LazyMemoryPersistence(makeSeed(log)),
    maxEvents: 2 * TURN_LEN,
  })
  const routes = buildSessionRoutes(mgr, TOKEN)
  await withCompactEnv('0', async () => {
    const { res, writes } = mockRes()
    await routes['GET /sessions/:id/stream']!({}, { id: 'long', since: '0' }, AUTH, res)
    const body = parseFrames(writes.join('')).filter((f) => f.payload.seq > 0)
    assert.equal(body.length, 2 * TURN_LEN)

    const handler = routes['GET /sessions/:id/events']!
    const hot = (await handler({}, { id: 'long', since: '0' }, AUTH)).body as { events: SessionEvent[] }
    assert.equal(hot.events.length, 2 * TURN_LEN)
    const cold = (await handler({}, { id: 'long', before: String(2 * TURN_LEN + 1), limit: String(TURN_LEN) }, AUTH)).body as { events: SessionEvent[] }
    assert.equal(cold.events.length, TURN_LEN)
  })
})

test('内存环与磁盘不受回放合并影响（getEvents 仍逐条）', async () => {
  const log = seedTurnLog(2)
  const persistence = new LazyMemoryPersistence(makeSeed(log))
  const mgr = new RuntimeSessionManager({ createAgent: () => new NoopAgent(), persistence })
  const routes = buildSessionRoutes(mgr, TOKEN)
  await withCompactEnv(undefined, () => routes['GET /sessions/:id/events']!({}, { id: 'long', since: '0' }, AUTH))
  const raw = mgr.getEvents('long', 0)!
  assert.equal(raw.events.length, log.length, '内存环逐条未变')
  assert.equal(persistence.loadEvents('long').length, log.length, '磁盘逐条未变')
})
