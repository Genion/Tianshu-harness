/**
 * 会话级 module store 收割回归——分两档（2026-09-16 审查修复）：
 * - 挂起级（releaseAgent：归档 / idle sweep 共用汇点）：清 wave 结果桥 / plan /
 *   待审集；**门禁类（wave-gate / skill-gate）必须保留**——plan-executor 的跨波
 *   门禁是 fail-open 判定（记录缺失即放行），挂起级清掉会让闲置恢复的会话绕开
 *   「上一波未过」的拦截（审查探针复现）。
 * - 终结级（hardDelete）：五张全清——会话永不重建，留着就是净泄漏。
 *
 * 原始病灶：五张模块级 Map 只注册不清理（clear* 全仓零生产调用方），死会话
 * 把整波 WorkerResult、计划 JSON、待审集永久钉在进程内；cron 每任务新
 * sessionId，长驻 sidecar 日积月累可达百 MB 级堆增长 + GC 停顿。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RuntimeSessionManager } from '../session-manager.js'
import { setWaveResults, getWaveResults } from '../../agent/wave-results-store.js'
import { setWaveGate, getWaveGate, clearWaveGate, type WaveGateRecord } from '../../agent/wave-gate.js'
import { storePlan, getStoredPlan } from '../../agent/plan-store.js'
import { addPendingReviewFiles, peekPendingReview, clearPendingReview } from '../../agent/post-commit-review-pending.js'
import { recordSkillInvoked, getInvokedSkills, clearSkillGate } from '../../agent/skill-gate.js'

function seedSessionStores(id: string): void {
  setWaveResults([{ finding: `result-of-${id}` } as never], id)
  const gate: WaveGateRecord = {
    wave: 0, passed: false, checks: [], changedFiles: [], commands: [], checkedAt: 1,
  }
  setWaveGate(gate, id)
  storePlan(`{"plan":"${id}"}`, id)
  addPendingReviewFiles(id, [`/tmp/${id}.ts`])
  recordSkillInvoked('review', id)
}

/** 挂起级期望：大对象清、门禁类留。 */
function assertReleaseCleared(id: string): void {
  assert.equal(getWaveResults(id), undefined, 'waveResults 未收割')
  assert.equal(getStoredPlan(id), null, 'plan-store 未收割')
  assert.equal(peekPendingReview(id), null, 'post-commit-review-pending 未收割')
}

/** 终结级期望：五张全清。 */
function assertAllCleared(id: string): void {
  assertReleaseCleared(id)
  assert.equal(getWaveGate(id), undefined, 'waveGate 未收割')
  assert.equal(getInvokedSkills(id).size, 0, 'skill-gate 未收割')
}

describe('session module stores reap on release', () => {
  let cwd: string
  let manager: RuntimeSessionManager

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), 'reap-'))
    manager = new RuntimeSessionManager({
      defaultCwd: cwd,
      // 本套用例不构建 agent（归档/硬删走 s.agent 为 null 的轻量路径）；
      // createAgent 为必填项，真被调用即视为测试假设失效
      createAgent: () => { throw new Error('this test must not build a real agent') },
    })
  })

  after(() => {
    manager.shutdownAll()
    rmSync(cwd, { recursive: true, force: true })
    // 测试卫生：五张表是模块级状态
    clearPendingReview(undefined)
  })

  it('archiveSession（releaseAgent 释放链）清大对象、保留门禁类记录', () => {
    const rec = manager.createSession({ cwd, title: 'reap-archive' })
    seedSessionStores(rec.id)
    seedSessionStores('sess-survivor')

    assert.ok(manager.archiveSession(rec.id), '归档应成功')

    assertReleaseCleared(rec.id)
    // 门禁类保留：闲置/归档恢复后从 fromWave>0 续跑，上一波未过的门禁必须仍在
    assert.ok(getWaveGate(rec.id), '归档不得清跨波门禁——fail-open 回归守卫')
    assert.equal(getInvokedSkills(rec.id).size, 1, '归档不得清 skill-gate 记录')
    // 不误伤：其他会话的条目原样保留
    assert.ok(getWaveResults('sess-survivor'))
    assert.ok(getWaveGate('sess-survivor'))
    assert.ok(getStoredPlan('sess-survivor'))
    assert.ok(peekPendingReview('sess-survivor'))
    assert.equal(getInvokedSkills('sess-survivor').size, 1)
    clearPendingReview('sess-survivor')
    // 测试卫生：门禁类现在跨用例存活，显式清理本用例播种的两会话
    clearWaveGate(rec.id)
    clearSkillGate(rec.id)
    clearWaveGate('sess-survivor')
    clearSkillGate('sess-survivor')
  })

  it('deleteSession（hardDelete 终结链）五张全清', () => {
    const rec = manager.createSession({ cwd, title: 'reap-delete' })
    // 上一个用例已把该路径的归档做完——这里重新播种后走 归档→硬删
    seedSessionStores(rec.id)
    assert.ok(manager.archiveSession(rec.id))
    // 归档时已清过一轮（门禁类保留）；重播种后验证 hardDelete 这条链全清
    seedSessionStores(rec.id)
    const deleted = manager.deleteSession(rec.id)
    assert.ok(deleted.ok, '归档会话应可硬删')

    assertAllCleared(rec.id)
  })
})

describe('clearPendingReview 只清目标会话', () => {
  it('A 清理不影响 B', () => {
    addPendingReviewFiles('sess-a', ['/a.ts'])
    addPendingReviewFiles('sess-b', ['/b.ts'])
    clearPendingReview('sess-a')
    assert.equal(peekPendingReview('sess-a'), null)
    assert.ok(peekPendingReview('sess-b'))
    assert.equal(peekPendingReview('sess-b')!.files.has('/b.ts'), true)
    clearPendingReview('sess-b')
  })
})
