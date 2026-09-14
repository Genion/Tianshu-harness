import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DetachedRunner } from '../post-session-detach.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('schedule 同步返回，任务按序执行且不并发', async () => {
  const r = new DetachedRunner()
  const order: string[] = []
  r.schedule(async () => { order.push('a:start'); await sleep(30); order.push('a:end') })
  r.schedule(async () => { order.push('b:start'); await sleep(5); order.push('b:end') })
  assert.deepEqual(order, [], 'schedule 不得同步执行任务')
  assert.equal(r.inFlight, 2)
  assert.equal(await r.drain(1_000), true)
  assert.deepEqual(order, ['a:start', 'a:end', 'b:start', 'b:end'])
  assert.equal(r.inFlight, 0)
})

test('单任务 reject 被吞，后续任务照常执行', async () => {
  const r = new DetachedRunner()
  let ran = false
  r.schedule(async () => { throw new Error('boom') })
  r.schedule(() => { ran = true })
  assert.equal(await r.drain(1_000), true)
  assert.equal(ran, true)
})

test('drain 超时返回 false，任务继续跑完', async () => {
  const r = new DetachedRunner()
  let done = false
  r.schedule(async () => { await sleep(120); done = true })
  assert.equal(await r.drain(20), false)
  assert.equal(done, false)
  assert.equal(await r.drain(1_000), true)
  assert.equal(done, true)
})

test('空链 drain 立即 true', async () => {
  assert.equal(await new DetachedRunner().drain(0), true)
})
