import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BASH_TOOL } from '../bash.js'
import { getShellCommand } from '../../platform.js'
import type { ToolCallParams } from '../types.js'

/**
 * Real-execution smoke test for the Windows command path. This is the ONLY
 * coverage that exercises the actual shell pick (Git Bash on the windows-latest
 * runner) end-to-end: spawn → stdio pipe → output capture → file side effects.
 * It guards against the "exit=0, empty stdout, no file written" silent failure.
 *
 * Skipped off Windows (the host shell there is `sh`, a different path covered by
 * bash.test.ts). The matching CI job runs this on windows-latest.
 */
const winOnly = { skip: process.platform !== 'win32' }

function makeParams(command: string, cwd: string): ToolCallParams {
  return { input: { command }, toolUseId: `smoke-${Math.random().toString(36).slice(2)}`, cwd }
}

// issue #144 的复现用例必须先于修复保持 opt-in：它在 windows-latest CI 上预期为红
//（taskkill /T 够不到 MSYS 后代），不设门会把共享 main 的 windows-smoke 作业钉死在红、
// 遮蔽同期其他回归。#144 修复合入时去掉此门；显式验证用 RIVET_ISSUE_144=1 开启。
const issue144Gate = process.env.RIVET_ISSUE_144
  ? {}
  : { skip: 'issue #144 复现用例待修复合入后启用（RIVET_ISSUE_144=1 显式开启）' }

describe('Windows bash smoke (real execution)', winOnly, () => {
  it('selects Git Bash on the runner', () => {
    const shell = getShellCommand()
    // windows-latest ships Git for Windows; we expect the Git Bash path.
    assert.equal(shell.kind, 'bash', `expected Git Bash, got kind=${shell.kind} cmd=${shell.cmd}`)
  })

  it('echo produces visible stdout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-smoke-'))
    try {
      const result = await BASH_TOOL.execute(makeParams('echo smoke-hello', dir))
      assert.match(result.content, /smoke-hello/, 'echo stdout must be captured (empty = stdio pipe broken)')
      assert.equal(result.isError, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('redirect actually writes a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-smoke-'))
    try {
      await BASH_TOOL.execute(makeParams('echo redirect-payload > out.txt', dir))
      const target = join(dir, 'out.txt')
      assert.ok(existsSync(target), 'redirect must create the file (missing = no side effect)')
      assert.match(readFileSync(target, 'utf-8'), /redirect-payload/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('pipe passes data between commands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-smoke-'))
    try {
      const result = await BASH_TOOL.execute(makeParams('echo pipe-line | grep pipe', dir))
      assert.match(result.content, /pipe-line/, 'pipe output must be captured')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('timeout kills the background descendant tree (issue #144)', issue144Gate, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-smoke-tree-'))
    const marker = join(dir, 'marker.txt')
    // 与 issue #144 的复现同形：Git Bash 用 `&` 把 node 放到后台（MSYS fork 派生，
    // 非纯 Win32 父子链），命令 50ms 超时触发 killProcessTree；若孙进程存活，
    // 300ms 后会把 marker 写出来。marker 的在场与否就是"进程树有没有被杀干净"的判据。
    const command = `nohup node -e "setTimeout(()=>require('fs').writeFileSync(process.argv[1],'alive'),300)" "${marker}" >/dev/null 2>&1 & wait`
    try {
      const result = await BASH_TOOL.execute({
        input: { command, timeout: 50 },
        toolUseId: 'smoke-tree-kill-144',
        cwd: dir,
      })
      assert.equal(result.isError, true, '超时命令必须返回错误结果')
      assert.match(result.content, /命令超时/)
      // marker 出现窗口改轮询：Git Bash 冷启动 + node.exe 冷启 + 300ms 定时器合计
      // 550–1100ms 不定，固定 700ms 在慢启动组合下假绿、快组合下随机红。
      // 窗口内 marker 出现 = 孙进程活着 = 树没杀净；窗口结束未见 = 杀净。
      const deadline = Date.now() + 5_000
      let markerSeen = false
      while (Date.now() < deadline && !(markerSeen = existsSync(marker))) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 100))
      }
      // 该判据的杀伤力已在 POSIX 侧用变异测试钉过：把 process-kill.ts 的负 PID
      // 进程组杀改为只杀直接子进程，同一用例立刻红（marker 被写入）。因此这里的
      // marker 出现等价于「进程树未被杀死」——即 taskkill /T 没够到 MSYS 后代。
      assert.equal(markerSeen, false, 'MSYS 后台孙进程逃过 taskkill /T——进程树未被杀死（issue #144）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
