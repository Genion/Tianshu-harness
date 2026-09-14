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
 * 冷热双通道（会话历史回放持久化 · Phase 1）：
 *  - getHistoryPage 绕过内存环直读磁盘，seq < before 分页 + turn 边界对齐
 *  - getReplayWindow 暴露「环截掉了头部」信号
 *  - /stream 回放最前发出 replay_window 合成元事件
 *  - GET /events?before= 冷通道路由分支
 * 设计：docs/superpowers/specs/2026-07-25-session-replay-durability-design.md
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
  loadEventsCalls: string[] = []

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
  loadEvents(id: string): SessionEvent[] {
    this.loadEventsCalls.push(id)
    return (this.events.get(id) ?? []).map((e) => ({ ...e }))
  }
  loadEventsAsync(id: string): Promise<SessionEvent[]> {
    return Promise.resolve(this.loadEvents(id))
  }
}

function ev(seq: number, type: SessionEvent['type'], data: Record<string, unknown> = {}): SessionEvent {
  return { seq, ts: 100 + seq, type, data }
}

/** 10 turns × 12 events（user 打头）= 120 条，seq 1..120。 */
function seedTurnLog(): SessionEvent[] {
  const out: SessionEvent[] = []
  let seq = 0
  for (let t = 1; t <= 10; t++) {
    out.push(ev(++seq, 'user', { text: `q${t}` }))
    for (let i = 0; i < 11; i++) out.push(ev(++seq, 'text_delta', { text: `a${t}-${i}` }))
  }
  return out
}

function makeSeed(events: SessionEvent[]): PersistedSession[] {
  return [{
    record: {
      id: 'long', status: 'completed', createdAt: 1, updatedAt: 9,
      cwd: '/work', lastSeq: events[events.length - 1]!.seq, pendingApprovals: 0,
    },
    events,
  }]
}

test('getHistoryPage：seq < before 分页 + 页首对齐 user 事件', async () => {
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: new LazyMemoryPersistence(makeSeed(seedTurnLog())),
    maxEvents: 24, // 环只装尾部两个 turn
  })
  // 打开会话（触发懒加载 + 环截尾）——floor = 120-24+1 = 97
  const replay = await mgr.getEventsAsync('long', 0)
  assert.equal(replay!.events[0]!.seq, 97, '环内回放从尾部开始')

  const page = await mgr.getHistoryPage('long', 97, 10)
  assert.ok(page)
  assert.equal(page.firstSeq, 1)
  assert.equal(page.lastSeq, 120)
  // seq < 97 的最后 10 条从 87 起，向前对齐到最近 user 事件 seq=85（turn 8 起点）。
  assert.equal(page.events[0]!.seq, 85)
  assert.equal(page.events[0]!.type, 'user')
  assert.equal(page.events[page.events.length - 1]!.seq, 96)
  // 页面全部 seq < before 且升序无重复。
  for (let i = 0; i < page.events.length; i++) {
    assert.ok(page.events[i]!.seq < 97)
    if (i > 0) assert.ok(page.events[i]!.seq > page.events[i - 1]!.seq)
  }
})

test('getHistoryPage：连续翻页无缝衔接直到 firstSeq', async () => {
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: new LazyMemoryPersistence(makeSeed(seedTurnLog())),
    maxEvents: 24,
  })
  await mgr.getEventsAsync('long', 0)

  const seen: number[] = []
  let before = 97
  for (let guard = 0; guard < 20 && before > 1; guard++) {
    const page = await mgr.getHistoryPage('long', before, 30)
    assert.ok(page)
    if (page.events.length === 0) break
    seen.unshift(...page.events.map((e) => e.seq))
    before = page.events[0]!.seq
  }
  // 头部 1..96 全部可达，无洞无重复。
  assert.equal(seen.length, 96)
  for (let i = 0; i < 96; i++) assert.equal(seen[i], i + 1)
})

test('getHistoryPage：seq 有洞时分页仍正确（只依赖单调性）', async () => {
  // 洞：删掉 seq 40..49（模拟损坏行被持久化层丢弃）。
  const events = seedTurnLog().filter((e) => e.seq < 40 || e.seq > 49)
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: new LazyMemoryPersistence(makeSeed(events)),
    maxEvents: 24,
  })
  await mgr.getEventsAsync('long', 0)

  const page = await mgr.getHistoryPage('long', 60, 15)
  assert.ok(page)
  // 页内不含洞中 seq，且仍以 user 事件打头。
  assert.equal(page.events[0]!.type, 'user')
  for (const e of page.events) {
    assert.ok(e.seq < 60)
    assert.ok(e.seq < 40 || e.seq > 49)
  }
})

test('getHistoryPage：向前无 user 事件时扩展到日志开头', async () => {
  // 日志不以 user 打头（截断/迁移遗留）：seq 1..5 是 status/text。
  const events: SessionEvent[] = [
    ev(1, 'status', { status: 'running' }),
    ev(2, 'text_delta', { text: 'x' }),
    ev(3, 'text_delta', { text: 'y' }),
    ev(4, 'user', { text: 'q' }),
    ev(5, 'text_delta', { text: 'z' }),
  ]
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: new LazyMemoryPersistence(makeSeed(events)),
  })
  await mgr.getEventsAsync('long', 0)

  // before=4，seq<4 的窗口里没有 user 事件 → 页从日志开头（seq=1）起。
  const page = await mgr.getHistoryPage('long', 4, 2)
  assert.ok(page)
  assert.equal(page.events[0]!.seq, 1)
  assert.deepEqual(page.events.map((e) => e.seq), [1, 2, 3])
})

test('getHistoryPage：ephemeral 模式（无持久化）回退内存环', async () => {
  const mgr = new RuntimeSessionManager({ createAgent: () => new NoopAgent() })
  const { id } = mgr.createSession({})
  const internal = mgr as unknown as { sessions: Map<string, { events: SessionEvent[]; seq: number }> }
  const s = internal.sessions.get(id)!
  for (const e of seedTurnLog()) {
    s.seq = e.seq
    s.events.push(e)
  }
  const page = await mgr.getHistoryPage(id, 25, 5)
  assert.ok(page)
  assert.equal(page.events[0]!.type, 'user')
  assert.ok(page.events.every((e) => e.seq < 25))
})

test('getReplayWindow：环截尾后暴露磁盘头部范围', async () => {
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: new LazyMemoryPersistence(makeSeed(seedTurnLog())),
    maxEvents: 24,
  })
  // 懒加载前（events 未进内存）不给误导性窗口——路由总是先 getEventsAsync。
  await mgr.getEventsAsync('long', 0)
  const win = mgr.getReplayWindow('long')
  assert.ok(win)
  assert.equal(win.floorSeq, 97)
  assert.equal(win.diskFirstSeq, 1)
  assert.equal(win.diskLastSeq, 120)
})

test('getReplayWindow：短会话（未截尾）floor 即磁盘头', async () => {
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: new LazyMemoryPersistence(makeSeed(seedTurnLog())),
  })
  await mgr.getEventsAsync('long', 0)
  const win = mgr.getReplayWindow('long')!
  assert.equal(win.floorSeq, 1)
  assert.equal(win.diskFirstSeq, 1)
  assert.equal(win.diskFirstSeq >= win.floorSeq, true, '未截尾时不显示加载入口')
})

/* ── 路由层 ─────────────────────────────────────────────── */

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

test('GET /events?before= 走冷通道分页；?since= 行为不变', async () => {
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: new LazyMemoryPersistence(makeSeed(seedTurnLog())),
    maxEvents: 24,
  })
  const routes = buildSessionRoutes(mgr, TOKEN)
  const handler = routes['GET /sessions/:id/events']!

  const hot = await handler({}, { id: 'long', since: '0' }, AUTH)
  assert.equal(hot.status, 200)
  const hotBody = hot.body as { events: SessionEvent[]; lastSeq: number }
  assert.equal(hotBody.events[0]!.seq, 97, '热通道仍只回环内尾部')
  assert.equal(hotBody.lastSeq, 120)

  const cold = await handler({}, { id: 'long', before: '97', limit: '10' }, AUTH)
  assert.equal(cold.status, 200)
  const coldBody = cold.body as { events: SessionEvent[]; firstSeq: number; lastSeq: number }
  assert.equal(coldBody.firstSeq, 1)
  assert.equal(coldBody.events[0]!.type, 'user')
  assert.ok(coldBody.events.every((e) => e.seq < 97))

  const missing = await handler({}, { id: 'nope', before: '97' }, AUTH)
  assert.equal(missing.status, 404)
})

test('GET /stream 回放最前发出 replay_window 元事件', async () => {
  const mgr = new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    persistence: new LazyMemoryPersistence(makeSeed(seedTurnLog())),
    maxEvents: 24,
  })
  const routes = buildSessionRoutes(mgr, TOKEN)
  const { res, writes } = mockRes()
  // 本测试断言逐条回放的帧数；回放合并（replay-compaction.ts）单独由
  // session-replay-compaction.test.ts 覆盖，这里显式关掉以隔离关注点。
  const prevCompact = process.env.RIVET_REPLAY_COMPACT
  process.env.RIVET_REPLAY_COMPACT = '0'
  try {
    await routes['GET /sessions/:id/stream']!({}, { id: 'long', since: '0' }, AUTH, res)
  } finally {
    if (prevCompact === undefined) delete process.env.RIVET_REPLAY_COMPACT
    else process.env.RIVET_REPLAY_COMPACT = prevCompact
  }

  const all = writes.join('')
  const firstFrameEnd = all.indexOf('\n\n')
  const firstFrame = all.slice(0, firstFrameEnd)
  assert.ok(firstFrame.startsWith('event: replay_window'), `首帧必须是 replay_window，实际: ${firstFrame.slice(0, 60)}`)
  const payload = JSON.parse(firstFrame.slice(firstFrame.indexOf('data: ') + 6)) as {
    seq: number; type: string; data: { floorSeq: number; diskFirstSeq: number; diskLastSeq: number }
  }
  assert.equal(payload.seq, 0, '合成事件 seq 恒为 0（不进 fold）')
  assert.deepEqual(payload.data, { floorSeq: 97, diskFirstSeq: 1, diskLastSeq: 120 })

  // 回放主体不受影响：环内 24 条全部送达且有序。
  const seqs = [...all.matchAll(/"seq":(\d+)/g)].map((m) => Number(m[1])).filter((n) => n > 0)
  assert.equal(seqs.length, 24)
  assert.equal(seqs[0], 97)
  assert.equal(seqs[23], 120)
})

test('RIVET_MAX_EVENTS 覆盖默认环容量（opts 未传时；下限 100 防病态小环）', () => {
  const prev = process.env.RIVET_MAX_EVENTS
  process.env.RIVET_MAX_EVENTS = '100'
  try {
    const mgr = new RuntimeSessionManager({
      createAgent: () => new NoopAgent(),
      persistence: new LazyMemoryPersistence(makeSeed(seedTurnLog())),
    })
    mgr.getEvents('long', 0) // 同步路径触发懒加载 + 截尾
    const win = mgr.getReplayWindow('long')!
    assert.equal(win.floorSeq, 21, '120 条日志按环容量 100 截到 21 起')
    assert.equal(win.diskFirstSeq, 1)

    // 低于下限的取值不生效（回退默认 5000）。
    process.env.RIVET_MAX_EVENTS = '30'
    const mgr2 = new RuntimeSessionManager({
      createAgent: () => new NoopAgent(),
      persistence: new LazyMemoryPersistence(makeSeed(seedTurnLog())),
    })
    mgr2.getEvents('long', 0)
    assert.equal(mgr2.getReplayWindow('long')!.floorSeq, 1, '<100 的取值回退默认，120 条不截')
  } finally {
    if (prev === undefined) delete process.env.RIVET_MAX_EVENTS
    else process.env.RIVET_MAX_EVENTS = prev
  }
})
