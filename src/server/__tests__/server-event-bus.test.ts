/**
 * 阶段 4 全局推送通道——ServerEventBus 合并语义。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ServerEventBus, type ServerBusEvent, type ServerEventBusTimers } from '../server-event-bus.js'

/** 手动推进的假计时器。 */
function fakeTimers() {
  let nextId = 1
  const pending = new Map<number, { fn: () => void; at: number }>()
  let now = 0
  const timers: ServerEventBusTimers = {
    setTimeout: (fn, ms) => {
      const id = nextId++
      pending.set(id, { fn, at: now + ms })
      return id
    },
    clearTimeout: (handle) => {
      pending.delete(handle as number)
    },
  }
  const advance = (ms: number) => {
    now += ms
    for (const [id, t] of [...pending.entries()].sort((a, b) => a[1].at - b[1].at)) {
      if (t.at <= now) {
        pending.delete(id)
        t.fn()
      }
    }
  }
  return { timers, advance, pendingCount: () => pending.size, now: () => now }
}

test('同类 publish 在合并窗口内只发一次；count 累计、reason 取最后一次', () => {
  const ft = fakeTimers()
  const bus = new ServerEventBus({ coalesceMs: 150, timers: ft.timers, now: ft.now })
  const seen: ServerBusEvent[] = []
  bus.subscribe((ev) => seen.push(ev))
  bus.publish('sessions_changed', 'record')
  bus.publish('sessions_changed', 'touch')
  bus.publish('sessions_changed', 'approvals')
  assert.equal(seen.length, 0, '窗口未到不发')
  ft.advance(149)
  assert.equal(seen.length, 0)
  ft.advance(1)
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0], { kind: 'sessions_changed', ts: 150, count: 3, reason: 'approvals' })
  assert.deepEqual(bus.stats(), { published: 3, emitted: 1, listeners: 1, pending: 0 })
})

test('不同 kind 各自开窗，互不合并', () => {
  const ft = fakeTimers()
  const bus = new ServerEventBus({ coalesceMs: 100, timers: ft.timers, now: ft.now })
  const seen: string[] = []
  bus.subscribe((ev) => seen.push(`${ev.kind}:${ev.count}`))
  bus.publish('sessions_changed')
  bus.publish('tasks_changed')
  bus.publish('tasks_changed')
  ft.advance(100)
  assert.deepEqual(seen.sort(), ['sessions_changed:1', 'tasks_changed:2'])
})

test('无订阅者时 publish 不建定时器（零成本），订阅后才开窗', () => {
  const ft = fakeTimers()
  const bus = new ServerEventBus({ coalesceMs: 100, timers: ft.timers })
  bus.publish('sessions_changed', 'record')
  assert.equal(ft.pendingCount(), 0)
  assert.equal(bus.stats().published, 1)
  const seen: ServerBusEvent[] = []
  const off = bus.subscribe((ev) => seen.push(ev))
  bus.publish('sessions_changed', 'record')
  assert.equal(ft.pendingCount(), 1)
  ft.advance(100)
  assert.equal(seen.length, 1)
  off()
  assert.equal(bus.listenerCount(), 0)
})

test('coalesceMs=0 同步直发', () => {
  const bus = new ServerEventBus({ coalesceMs: 0, now: () => 42 })
  const seen: ServerBusEvent[] = []
  bus.subscribe((ev) => seen.push(ev))
  bus.publish('tasks_changed', 'created')
  assert.deepEqual(seen, [{ kind: 'tasks_changed', ts: 42, count: 1, reason: 'created' }])
})

test('坏订阅者不影响其他订阅者', () => {
  const bus = new ServerEventBus({ coalesceMs: 0 })
  const seen: string[] = []
  bus.subscribe(() => { throw new Error('half-dead sse') })
  bus.subscribe((ev) => seen.push(ev.kind))
  bus.publish('sessions_changed')
  assert.deepEqual(seen, ['sessions_changed'])
})

test('close 清掉在飞窗口，之后 publish / subscribe 为空操作', () => {
  const ft = fakeTimers()
  const bus = new ServerEventBus({ coalesceMs: 100, timers: ft.timers })
  const seen: ServerBusEvent[] = []
  bus.subscribe((ev) => seen.push(ev))
  bus.publish('sessions_changed')
  assert.equal(ft.pendingCount(), 1)
  bus.close()
  assert.equal(ft.pendingCount(), 0)
  ft.advance(100)
  assert.equal(seen.length, 0)
  bus.publish('sessions_changed')
  bus.subscribe((ev) => seen.push(ev))
  assert.equal(bus.listenerCount(), 0)
  assert.equal(bus.stats().emitted, 0)
})
