/**
 * Stop → settle window（2026-09-13，桌面端「编辑重发保存失败」根因）。
 *
 * abort() 同步把 record.status 翻成 'aborted' 并发 status 事件，但 `running`
 * 要等 agent loop 收尾、run() 的 finally 追加 `done` 才落下。桌面端编辑重发的
 * 序列是 abort → 轮询 GET /sessions/:id 到非 running → POST /rewind → POST
 * /prompt；三个客户端可见的 idle 信号全部落在这个窗口里，rewind/prompt 撞上
 * `running` 守卫 → 409（「保存失败：Session is running or index out of range」
 * / 「会话正在执行中」）。修复：停下来的 run 由服务端等它真正收尾
 * （waitForRunSettled），仍在跑的 run 保持立即 409。
 *
 * 反证表（每条对应一种偷懒实现会挂）：
 *   #1 「路由不等收尾」→ 窗口内 rewind 仍 409
 *   #2 「无条件等」→ 未 abort 的 live run 也会阻塞到超时（#3 要求立即 409）
 *   #3 「prompt 路由没接」→ Stop 后立刻发新消息仍 409 busy
 *   #4 「超时后不放行」→ 收尾超过 timeout 时必须返回 false 而不是挂死
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { buildSessionRoutes } from '../session-routes.js'
import { createRouter } from '../index.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TOKEN = 'tok'
const AUTH = { authorization: `Bearer ${TOKEN}` }

/**
 * Mirrors the real AgentLoop's stop behaviour: abort() only flips a signal;
 * run() settles `settleDelayMs` later (stream teardown / postTurn hooks).
 * Every turn appends user + assistant messages so rewind points pair 1:1 with
 * `user` events (same shape as the production prompt flow).
 */
class SlowAbortAgent implements ManagedAgent {
  messages: OaiMessage[] = []
  private settle?: () => void
  constructor(private readonly settleDelayMs: number) {}
  run(prompt: string, _cb: AgentCallbacks): Promise<void> {
    this.messages.push({ role: 'user', content: prompt })
    return new Promise<void>((resolve) => {
      this.settle = () => {
        this.messages.push({ role: 'assistant', content: 'ok' })
        resolve()
      }
    })
  }
  /** Test hook: finish the turn normally (no abort). */
  complete(): void { const s = this.settle; this.settle = undefined; s?.() }
  abort(): void { setTimeout(() => this.complete(), this.settleDelayMs).unref() }
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return this.messages }
  replaceMessages(m: OaiMessage[]): void { this.messages = m }
  rewindToMessages(m: OaiMessage[]): void { this.messages = m }
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Session with one settled turn and a second turn still running. */
async function setup(settleDelayMs = 200) {
  let agent!: SlowAbortAgent
  const manager = new RuntimeSessionManager({
    createAgent: () => { agent = new SlowAbortAgent(settleDelayMs); return agent },
    defaultCwd: '/tmp',
  })
  const router = createRouter(buildSessionRoutes(manager, TOKEN))
  const id = manager.createSession({ title: 'settle-window' }).id
  assert.ok(manager.run(id, 'first message'))
  await tick(5)
  agent.complete()
  await tick(5)
  assert.equal(manager.getSession(id)!.status, 'completed')
  assert.ok(manager.run(id, 'second message with typo'))
  await tick(5)
  assert.equal(manager.getSession(id)!.status, 'running')
  return { manager, router, id, agent: () => agent }
}

const isRunning = (manager: RuntimeSessionManager, id: string): boolean =>
  (manager as unknown as { sessions: Map<string, { running: boolean }> }).sessions.get(id)!.running

test('#1 POST /rewind inside the stop→settle window waits for the run to settle instead of 409', async () => {
  const { manager, router, id } = await setup()
  const points = (await manager.listRewindPoints(id))!
  const target = points.find((p) => p.content === 'second message with typo')!

  // Desktop sequence: abort → GET shows non-running immediately → rewind.
  assert.equal((await router('POST', `/sessions/${id}/abort`, {}, AUTH)).status, 200)
  const rec = await router('GET', `/sessions/${id}`, {}, AUTH)
  assert.equal((rec.body as { status: string }).status, 'aborted', 'status flips at once…')
  assert.equal(isRunning(manager, id), true, '…while the run is still unwinding')

  const res = await router('POST', `/sessions/${id}/rewind`, { messageIndex: target.index }, AUTH)
  assert.equal(res.status, 200, 'rewind must ride out the settle window')
  assert.equal(isRunning(manager, id), false, 'route only proceeded once the run had settled')
  assert.equal(manager.getSession(id)!.status, 'idle')
  // Truncated at the edited message: only the first turn remains.
  assert.deepEqual((await manager.listRewindPoints(id))!.map((p) => p.content), ['first message'])
  // 事件顺序的真实契约：桌面 reducer 靠 status:aborted 关闭 run 展示（abort 时同步
  // 追加，event-reducer.ts:1083），而不是 done——被中止的 run 因升代失去 durability，
  // 永不追加 done（本流里唯一的 done 来自第一轮正常完成）。
  const events = manager.getEvents(id, 0)!.events
  const dump = events.map((e) => `${e.type}:${(e.data as { status?: string }).status ?? ''}`).join(',')
  const abortIdx = events.findIndex(
    (e) => e.type === 'status' && (e.data as { status?: string }).status === 'aborted',
  )
  const rewindIdx = events.findIndex((e) => e.type === 'rewind')
  assert.ok(abortIdx >= 0, `stream must contain status:aborted: ${dump}`)
  assert.ok(rewindIdx > abortIdx, `rewind must follow status:aborted: ${dump}`)
  assert.equal(
    events.filter((e) => e.type === 'done').length,
    1,
    `aborted run must not append done — only the first settled turn leaves one: ${dump}`,
  )
})

test('#2 a live run nobody stopped still gets an immediate 409 (no blocking wait)', async () => {
  const { manager, router, id, agent } = await setup(5_000)
  const started = Date.now()
  const res = await router('POST', `/sessions/${id}/rewind`, { messageIndex: 2 }, AUTH)
  assert.equal(res.status, 409)
  assert.ok(Date.now() - started < 500, 'must not wait out the settle timeout for a run that was never stopped')
  assert.equal(manager.getSession(id)!.status, 'running', 'untouched')
  assert.equal(await manager.waitForRunSettled(id, 50), false, 'waitForRunSettled reports false without waiting')
  // Same for /prompt: a live run keeps the busy semantics (desktop routes to steer/queue).
  const busy = await router('POST', `/sessions/${id}/prompt`, { prompt: 'x' }, AUTH)
  assert.equal(busy.status, 409)
  assert.equal((busy.body as { code?: string }).code, 'busy')
  // Cleanup: settle the hanging run so the process is not held open.
  agent().complete()
  await tick(5)
})

test('#3 POST /prompt right after Stop starts the new turn instead of 409 busy', async () => {
  const { manager, router, id } = await setup()
  assert.equal((await router('POST', `/sessions/${id}/abort`, {}, AUTH)).status, 200)
  assert.equal(isRunning(manager, id), true, 'precondition: inside the settle window')

  const res = await router('POST', `/sessions/${id}/prompt`, { prompt: 'third message' }, AUTH)
  assert.equal(res.status, 200, `expected the prompt to start after settlement, got ${JSON.stringify(res.body)}`)
  assert.equal(manager.getSession(id)!.status, 'running')
  const userTexts = manager.getEvents(id, 0)!.events.filter((e) => e.type === 'user').map((e) => e.data.text)
  assert.deepEqual(userTexts, ['first message', 'second message with typo', 'third message'])
})

test('#4 waitForRunSettled: true when idle, false after timeout while still unwinding, true once settled', async () => {
  const { manager, id } = await setup(300)
  manager.abort(id)
  assert.equal(await manager.waitForRunSettled(id, 30), false, 'still unwinding after 30ms')
  assert.equal(isRunning(manager, id), true)
  assert.equal(await manager.waitForRunSettled(id, 1_000), true, 'settles within the 300ms abort delay')
  assert.equal(isRunning(manager, id), false)
  assert.equal(await manager.waitForRunSettled(id), true, 'idle session resolves immediately')
  assert.equal(await manager.waitForRunSettled('missing-session'), false)
})

test('#5 任务 2 之后：agent 侧 settle 缩到 drain 级（≤100ms）时，abort → 立刻 POST /prompt 的等待 <300ms', async () => {
  // AgentLoop 侧已改（2026-09-13 Stop→settle 根治）：abort 出口 inline 只留 drain，
  // postSession 进后台串行链——abort-settles-before-post-session.test.ts 实测 run()
  // 在 <700ms 内 settle（即便挂着一个 2s 的 postSession hook）。此处以 settleDelayMs=80
  // 模拟该量级，钉住服务端受理随之提前（修复前该窗口是秒级 + 桌面端 409）。
  const { router, id } = await setup(80)
  assert.equal((await router('POST', `/sessions/${id}/abort`, {}, AUTH)).status, 200)
  const t0 = Date.now()
  const res = await router('POST', `/sessions/${id}/prompt`, { prompt: 'again' }, AUTH)
  assert.equal(res.status, 200)
  assert.ok(Date.now() - t0 < 300, `等待 ${Date.now() - t0}ms`)
})
