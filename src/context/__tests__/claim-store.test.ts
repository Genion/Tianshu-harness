import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextClaimStore } from '../claim-store.js'
import type { ClaimProposal } from '../claims.js'
import { SessionPersist } from '../../agent/session-persist.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'rivet-claims-'))
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function proposal(text = 'Do not repeat failed Read calls'): ClaimProposal {
  return {
    kind: 'user_constraint',
    scope: 'session',
    text,
    confidence: 0.9,
    fitness: 5,
    source: { actor: 'user', sessionId: 'session-123', turn: 1, eventId: 'turn-1:user-input' },
    evidence: [{ id: 'e1', kind: 'user_message', summary: text, createdAt: 10 }],
    createdAt: 10,
    tags: ['anchor', 'user_constraint'],
  }
}

test('proposes a claim by appending a JSONL event and projecting current claims', async () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')

    const claim = store.propose(proposal())
    const claims = store.listClaims()

    assert.equal(claim.status, 'active')
    assert.equal(claims.length, 1)
    assert.equal(claims[0]?.text, 'Do not repeat failed Read calls')

    await store.flushWrites() // write-behind：原始文件断言前先排空写链
    const raw = readFileSync(store.path, 'utf-8')
    assert.match(raw, /"type":"claim_proposed"/)
    assert.match(raw, /Do not repeat failed Read calls/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('replays claim status transitions from JSONL', async () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const claim = store.propose(proposal())

    store.updateClaimStatus(claim.id, 'stale', 'evidence expired')

    await store.flushWrites() // write-behind：重载前先排空写链
    const reloaded = new ContextClaimStore(dir, 'session-123')
    const claims = reloaded.listClaims()

    assert.equal(claims.length, 1)
    assert.equal(claims[0]?.status, 'stale')
    assert.equal(claims[0]?.counterevidence[0]?.summary, 'evidence expired')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('proposing the same semantic claim is idempotent and preserves status transitions', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const first = store.propose(proposal('Always run tests before done'))
    store.updateClaimStatus(first.id, 'quarantined', 'superseded by counterevidence')
    const repeated = store.propose({
      ...proposal('  always   run tests BEFORE done  '),
      source: { actor: 'user', sessionId: 'session-123', turn: 2, eventId: 'turn-2:user-input' },
      evidence: [{ id: 'e2', kind: 'user_message', summary: 'Always run tests before done', createdAt: 20 }],
      createdAt: 20,
    })

    assert.equal(repeated.id, first.id)
    assert.equal(store.listClaims().length, 1)
    assert.equal(store.listClaims()[0]?.status, 'quarantined')
    assert.equal(store.exportSession().match(/claim_proposed/g)?.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('filters active claims and excludes quarantined claims', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const active = store.propose(proposal('Keep this active'))
    const quarantined = store.propose(proposal('Do not project this'))
    store.updateClaimStatus(quarantined.id, 'quarantined', 'counter evidence')

    const activeClaims = store.listActiveClaims()

    assert.deepEqual(activeClaims.map(c => c.id), [active.id])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('cached projections are invalidated after appended events', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const claim = store.propose(proposal('Cache this claim'))

    assert.equal(store.listClaims()[0]?.status, 'active')
    store.updateClaimStatus(claim.id, 'stale', 'cache must refresh')

    const claims = store.listClaims()
    assert.equal(claims.length, 1)
    assert.equal(claims[0]?.status, 'stale')
    assert.equal(claims[0]?.counterevidence[0]?.summary, 'cache must refresh')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('active claim listing excludes expired claims at the supplied time', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const durable = store.propose(proposal('Keep this claim'))
    const expired = store.propose({ ...proposal('Drop this expired claim'), expiresAt: 20 })

    assert.deepEqual(store.listActiveClaims(19).map(c => c.id), [durable.id, expired.id])
    assert.deepEqual(store.listActiveClaims(20).map(c => c.id), [durable.id])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ignores invalid JSONL lines while preserving valid events', async () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const claim = store.propose(proposal())
    await store.flushWrites() // write-behind：落盘后再注入坏行
    writeFileSync(store.path, `${readFileSync(store.path, 'utf-8')}not json\n`, 'utf-8')

    const reloaded = new ContextClaimStore(dir, 'session-123')

    assert.equal(reloaded.listClaims()[0]?.id, claim.id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('records prompt consumers without changing prompt eligibility', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const claim = store.propose(proposal())

    store.recordClaimUsed(claim.id, {
      consumerId: 'turn-2:prompt',
      consumerKind: 'prompt',
      usedAt: 20,
    })

    const [used] = store.listActiveClaims()
    assert.equal(used?.lastUsedAt, 20)
    assert.deepEqual(used?.consumers, [{ id: 'turn-2:prompt', kind: 'prompt', usedAt: 20 }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lists claims with file evidence and summarizes lifecycle statuses', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const fileClaim = store.propose({
      ...proposal('Observed config'),
      kind: 'file_observation',
      evidence: [{ id: 'f1', kind: 'file', summary: 'config', path: '/repo/src/config.ts', createdAt: 10 }],
    })
    const active = store.propose(proposal('Keep active'))
    store.updateClaimStatus(active.id, 'durable', 'user confirmed')

    assert.deepEqual(store.listClaimsByFileEvidence('/repo/src/config.ts').map(c => c.id), [fileClaim.id])
    assert.deepEqual(store.getStatusCounts(), {
      active: 1,
      stale: 0,
      conflicted: 0,
      durable: 1,
      durableCandidate: 0,
      quarantined: 0,
      recallBlocked: 0,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('promotes eligible claims by appending status transition events', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const claim = store.propose(proposal('Project this claim repeatedly'))
    for (const turn of [1, 2, 3]) {
      store.recordClaimUsed(claim.id, { consumerId: `turn-${turn}:prompt`, consumerKind: 'prompt', usedAt: turn })
    }

    const promoted = store.promoteEligibleClaims(4)

    assert.deepEqual(promoted.map(c => c.id), [claim.id])
    assert.equal(store.listClaims()[0]?.status, 'durable_candidate')
    assert.match(store.exportSession(), /claim_status_changed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('marks claims with matching file evidence as stale', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const fileClaim = store.propose({
      ...proposal('Observed file'),
      kind: 'file_observation',
      evidence: [{ id: 'f1', kind: 'file', summary: 'file', path: '/repo/src/a.ts', createdAt: 10 }],
    })

    const updated = store.markClaimsStaleForFile('/repo/src/a.ts', 'file modified')

    assert.deepEqual(updated.map(c => c.id), [fileClaim.id])
    assert.equal(store.listClaims()[0]?.status, 'stale')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SessionPersist creates a claim store for the current session id', () => {
  const persist = new SessionPersist('session-claims-test', process.cwd())
  const store = persist.createClaimStore()

  assert.match(store.path, /session-claims-test\.claims\.jsonl$/)
})

test('loadDurableClaims returns only durable claims from a session file', async () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-old')
    const active = store.propose(proposal('Active claim'))
    const durable = store.propose(proposal('Durable claim'))
    store.updateClaimStatus(durable.id, 'durable_candidate', 'promoted')
    store.updateClaimStatus(durable.id, 'durable', 'promotion threshold met')

    await store.flushWrites() // write-behind：跨实例读盘前先排空写链
    const loaded = ContextClaimStore.loadDurableClaims(dir, 'session-old')
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0]!.text, 'Durable claim')
    assert.equal(loaded[0]!.status, 'durable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadDurableClaims returns empty for nonexistent session', () => {
  const dir = tempDir()
  try {
    const loaded = ContextClaimStore.loadDurableClaims(dir, 'nonexistent')
    assert.equal(loaded.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('boostFitness increases fitness by delta', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-boost-'))
  try {
    const store = new ContextClaimStore(dir, 'session-1')
    const claim = store.propose({
      kind: 'file_observation',
      scope: 'session',
      text: 'config uses port 3000',
      confidence: 0.7,
      fitness: 3,
      source: { actor: 'tool', sessionId: 'session-1', turn: 1, eventId: 'e1' },
      evidence: [{ id: 'ev1', kind: 'tool_result', summary: 'x', createdAt: Date.now() }],
      createdAt: Date.now(),
      tags: ['test'],
    })

    const updated = store.boostFitness(claim.id, 2, 10)

    assert.equal(updated!.fitness, 5)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('boostFitness caps fitness at max value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-boost-'))
  try {
    const store = new ContextClaimStore(dir, 'session-1')
    const claim = store.propose({
      kind: 'file_observation',
      scope: 'session',
      text: 'high fitness claim',
      confidence: 0.7,
      fitness: 9,
      source: { actor: 'tool', sessionId: 'session-1', turn: 1, eventId: 'e2' },
      evidence: [{ id: 'ev2', kind: 'tool_result', summary: 'x', createdAt: Date.now() }],
      createdAt: Date.now(),
      tags: ['test'],
    })

    const updated = store.boostFitness(claim.id, 5, 10)

    assert.equal(updated!.fitness, 10)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('boostFitness returns null for nonexistent claim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-boost-'))
  try {
    const store = new ContextClaimStore(dir, 'session-1')
    const result = store.boostFitness('nonexistent', 1, 10)
    assert.equal(result, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('caps consumers array per claim at MAX_CONSUMERS (50)', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const claim = store.propose(proposal('Consumer cap test'))

    // Record 60 usage events
    for (let i = 0; i < 60; i++) {
      store.recordClaimUsed(claim.id, {
        consumerId: `turn-${i}:prompt`,
        consumerKind: 'prompt',
        usedAt: Date.now() + i,
      })
    }

    const claims = store.listActiveClaims()
    const updated = claims.find(c => c.id === claim.id)!
    assert.ok(updated.consumers.length <= 50, `consumers length ${updated.consumers.length} should be <= 50`)
    // Most recent consumers should be kept
    assert.equal(updated.consumers[updated.consumers.length - 1]!.id, 'turn-59:prompt')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('evicts stale claims beyond MAX_ACTIVE_CLAIMS (50)', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')

    // Create 55 active claims with distinct createdAt
    for (let i = 0; i < 55; i++) {
      store.propose({ ...proposal(`Claim ${i}`), createdAt: i * 1000 })
    }

    const active = store.listActiveClaims()
    // After eviction, should be <= 50
    assert.ok(active.length <= 50, `active claims ${active.length} should be <= 50`)
    // Oldest claims (lowest createdAt) should be evicted — Claim 0..4 gone, Claim 5 first remaining
    assert.equal(active[0]!.text, 'Claim 5')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 永久性写失败的收场（挂死源回归）─────────────────────────────────
// 病灶：写链 catch 对所有错误一律「回填 pendingLines → 等 250ms → 重试」，且
// finally 在 pendingLines 非空时**无限重建**链。目录被删（ENOENT）/权限变更这类
// **永久性**错误下，250ms 定时器链永不终止 → 事件循环永远非空 → `node --test`
// 既不打印汇总也不退出。
// 实测：context-injection.test.ts 因 finally 里 rmSync 掉 claimStore 的目录而挂死，
// 进而使整批被 runner 看门狗收场、跨批汇总只覆盖 1/3。
test('写链对永久性错误放弃自动重试——不留永久定时器链', async () => {
  const dir = tempDir()
  const store = new ContextClaimStore(dir, 'session-perm-fail')
  store.propose(proposal('permanent write failure probe'))
  // 制造永久性错误：目录不存在 → appendFile 恒 ENOENT
  rmSync(dir, { recursive: true, force: true })

  await store.flushWrites(2_000)

  const s = store as unknown as {
    permanentWriteFailure?: boolean
    writeChain?: { running: boolean }
  }
  assert.equal(s.permanentWriteFailure, true, '永久性写失败应被记录并停止自动重试')
  assert.equal(s.writeChain?.running, false, '写链必须已停止（否则 250ms 定时器链永不释放）')
})

// ── 短暂文件锁的梯度重试（agent-16：AV/EDR 秒级锁会自愈）────────────────
// 病灶：EACCES/EPERM 在永久集里「一次失败即停链」——锁自愈后链不再重试，
// 滞留行留在内存；会话末（无新事件、无收口 flush 调用）撞锁即丢行。
// 修复：EACCES/EPERM/EBUSY（及未知码）走梯度——连续 N 次失败才转永久；
// 成功即清零；ENOENT 族保持立即永久（重试不改变结果）。
test('短暂 EACCES：锁释放后梯度重试自愈（无需新事件）', async () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-lock-heal', { checkpointEveryEvents: 0 })
    store.propose(proposal('baseline'))
    await store.flushWrites()
    const base = statSync(store.path).size

    chmodSync(store.path, 0o444) // 短暂锁：只读（AV/EDR 扫描窗口同构）
    store.propose(proposal('while locked'))
    await sleep(600) // 保持锁住约 2 个重试周期
    assert.equal(statSync(store.path).size, base, '锁未释放时不该写入')

    chmodSync(store.path, 0o644) // 锁释放（扫描结束）
    await sleep(900) // 梯度重试窗口（250ms 间隔）
    assert.ok(statSync(store.path).size > base, '锁释放后应自愈落盘——梯度重试不依赖新事件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('持续 EACCES 耗尽梯度：转永久停链；新事件清位后恢复', async () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-lock-exhaust', {
      checkpointEveryEvents: 0,
      maxTransientWriteRetries: 2,
    })
    store.propose(proposal('baseline'))
    await store.flushWrites()
    const base = statSync(store.path).size

    chmodSync(store.path, 0o444)
    store.propose(proposal('locked-1'))
    await sleep(900) // 2 次重试耗尽 → 停链
    chmodSync(store.path, 0o644)
    await sleep(800)
    assert.equal(statSync(store.path).size, base, '梯度耗尽后应停链——锁释放也不自愈（防定时器链永不终止）')

    const s = store as unknown as { permanentWriteFailure?: boolean }
    assert.equal(s.permanentWriteFailure, true, '梯度耗尽应记录为永久性失败')

    // 新事件 kick 清位：环境恢复后不丢行（滞留行与最新行一起写回）
    store.propose(proposal('after-recovery'))
    await store.flushWrites()
    assert.ok(statSync(store.path).size > base, '新事件应清位重试全部积压行')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 生产收口接线契约（agent-16）────────────────────────────────────────
// write-behind 队列在进程退出时被直接丢弃——收口 flush 必须挂在会话 shutdown
// 路径上（TUI 的 createShutdownHandler / sidecar 的 ManagedAgent.shutdown）。
// 源码级契约（serve-agent-gate-wiring 先例）防未来重构悄悄摘除调用点。
test('shutdown 收口接线：TUI 与 sidecar 两条会话关闭路径均排空 claim 写链', () => {
  const serveAgent = readFileSync(new URL('../../server/serve-agent.ts', import.meta.url), 'utf8')
  assert.match(serveAgent, /stores\.claimStore\.flushWrites\(2_000\)/, 'sidecar 会话 shutdown 未排空 claim 写链')
  const bootstrapSource = readFileSync(new URL('../../bootstrap.ts', import.meta.url), 'utf8')
  assert.match(bootstrapSource, /ctx\.claimStore\.flushWrites\(2_000\)/, 'TUI shutdown 未排空 claim 写链')
})

// ── flush 撞上运行中的写链（agent-16 审查跟进项：「again 吞一拍」）──────────
// 病灶：flush 入口 kick 若落在运行中的链上被吞为 again（不清位），链随后梯度
// 耗尽停链——flush 只剩轮询空转到超时，一行也排不掉（shutdown flush 恰好撞上
// AV 锁持续期的典型形态）。修复：flush 轮询观测「链停 + 有滞留」时清位重踢
// 一次（有界防热循环）；补踢后仍停链则确认排不掉、提前返回不空转。
test('flush 撞上运行中的写链：链随后耗尽停链时补踢排空（不空转）', async () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-flush-requeue', {
      checkpointEveryEvents: 0,
      maxTransientWriteRetries: 2,
    })
    store.propose(proposal('baseline'))
    await store.flushWrites()
    const base = statSync(store.path).size

    chmodSync(store.path, 0o444)
    store.propose(proposal('locked'))
    await sleep(80) // 链第一次失败后的 250ms 退避中（running=true）
    const flushing = store.flushWrites(1_500) // 入口 kick 撞运行中链 → again（不清位）
    await sleep(400) // 链第二次失败 → 梯度耗尽 → 停链
    chmodSync(store.path, 0o644) // 锁释放
    await flushing
    assert.ok(statSync(store.path).size > base, 'flush 应补踢已停链的滞留行——锁释放后即排空')
  } finally {
    try { chmodSync(join(dir, 'session-flush-requeue.claims.jsonl'), 0o644) } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true })
  }
})
