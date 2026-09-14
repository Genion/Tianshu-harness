import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { refreshAgentTools } from '../agent-tool-refresh.js'

describe('refreshAgentTools（issue #8：配置落盘后刷新存活 agent 的工具表）', () => {
  it('对每个已构建的 agent 调一次 updateTools 并计数', () => {
    const calls: string[] = []
    const sessions = [
      { agent: { updateTools: () => { calls.push('a') } } },
      { agent: { updateTools: () => { calls.push('b') } } },
    ]
    assert.equal(refreshAgentTools(sessions), 2)
    assert.deepEqual(calls, ['a', 'b'], '每个 agent 恰好一次')
  })

  it('跳过尚未构建的 agent（无 agent / agent 上没有该方法）', () => {
    const sessions = [
      {},
      { agent: undefined },
      { agent: {} },
      { agent: { updateTools: () => { /* 只有这一个可刷 */ } } },
    ]
    assert.equal(refreshAgentTools(sessions), 1, '只该刷到真正可刷的那一个')
  })

  // 尽力而为，不是事务：一个会话的 agent 已经销毁/异常，不该阻断其余会话拿到新工具表。
  it('单个 agent 抛异常不影响其余', () => {
    const survived: string[] = []
    const sessions = [
      { agent: { updateTools: () => { throw new Error('会话已销毁') } } },
      { agent: { updateTools: () => { survived.push('second') } } },
      { agent: { updateTools: () => { survived.push('third') } } },
    ]
    assert.equal(refreshAgentTools(sessions), 2, '成功数不含抛异常的那个')
    assert.deepEqual(survived, ['second', 'third'], '前一个失败不该中断后继')
  })

  it('空集合返回 0', () => {
    assert.equal(refreshAgentTools([]), 0)
  })
})
