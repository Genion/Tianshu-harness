/**
 * bash 工具对「全量类型检查」形态的超时契约。
 *
 * ## 为什么需要这份契约
 * bash 工具会把 typecheck 形态的命令送进跨进程共享闸门
 * （`executeBashMaybeSerialized` → `runAdhocTypecheckShared`）。闸门的所有会话与
 * 隔离 worktree **共用一把锁**（worktree 的 node_modules 是指向主仓的 symlink，
 * 缓存目录物理上是同一把），持锁者满载时等待预算是 10 分钟
 * （`typecheck-cache.ts` 的 `DEFAULT_WAIT_BUDGET_MS = STALE_LOCK_MS`）。
 *
 * 而工具管线给的默认预算是 `DEFAULT_TOOL_TIMEOUT_MS = 120_000`
 * （`src/agent/tool-pipeline.ts`）。**工具声明的预算小于它自己选用的闸门预算**，
 * 于是高负载下必然 `[tool-timeout] bash timed out after 120s`——不是命令慢，
 * 是这两个数字从来没对齐过。2026-09-14 在并行审查 worker 里实测复现。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BASH_TOOL } from '../bash.js'
import { isTypecheckCommand } from '../../lsp/typecheck-cache.js'
import type { ToolCallParams } from '../types.js'

/** 闸门等待上限（typecheck-cache.ts 的 STALE_LOCK_MS = 10 分钟）。 */
const GATE_WAIT_BUDGET_MS = 10 * 60_000

function timeoutFor(command: string): number {
  return BASH_TOOL.timeoutMs?.({ input: { command } } as unknown as ToolCallParams) ?? 0
}

test('typecheck 形态拿到的工具级预算必须覆盖闸门等待上限', () => {
  // 这些形态会被 isTypecheckCommand 判为 YES 并因此走闸门——预算小一毫秒，
  // 高负载下就是必然超时。
  const commands = [
    'npm run typecheck',
    'npm run typecheck 2>&1 | tail -25',
    'npx tsc --noEmit',
    'tsc --noEmit',
    'npm exec -- tsc --noEmit',
  ]
  for (const cmd of commands) {
    assert.ok(isTypecheckCommand(cmd), `前提：${cmd} 应被判为 typecheck 形态`)
    assert.ok(
      timeoutFor(cmd) >= GATE_WAIT_BUDGET_MS,
      `${cmd} 的工具预算 ${timeoutFor(cmd)}ms 小于闸门等待上限 ${GATE_WAIT_BUDGET_MS}ms——会必然超时`,
    )
  }
})

test('普通命令保持默认预算，不因这次修复被放大', () => {
  for (const cmd of ['ls -la', 'npm run build', 'npm test', 'git status']) {
    assert.equal(timeoutFor(cmd), 120_000, `${cmd} 不该拿到 typecheck 的长预算`)
  }
})

test('tsc --watch 是长跑形态，不算 typecheck 收口对象', () => {
  // isTypecheckCommand 的注释声明「--watch 等长跑形态不匹配（走后台 job 通道）」，
  // 但 2026-09-14 探针实测它匹配。watch 进程永不退出：送进闸门等于占着锁不放，
  // 真正的 typecheck 反而被它挡住；前台跑还会等到工具超时。
  assert.equal(isTypecheckCommand('tsc --noEmit --watch'), false, 'watch 形态不该进闸门')
  assert.equal(timeoutFor('tsc --noEmit --watch'), 120_000, 'watch 形态保持默认预算')
})
