/**
 * logs-cli.ts — `rivet logs` 的实现。
 *
 * 为什么要有 CLI 版而不只是 `/logs` 斜杠命令：出问题时 TUI 往往起不来
 * （sidecar 崩、配置坏、终端不是 TTY），那正是最需要知道日志在哪的时刻。
 * 这条路径不初始化 agent、不读配置、不联网，只做路径推导 + stat。
 *
 * `--json` 是给上报用的：贡献者可以把结构化落点清单直接贴进 issue，
 * 不必逐条描述自己的目录结构。
 */

import { spawn } from 'node:child_process'
import { buildOpenPathCommand } from '../tools/open-path.js'
import {
  resolveLogLocations,
  statLogLocations,
  formatLogLocationReport,
  latestSessionId,
} from './log-locations.js'

export interface LogsCliDeps {
  readonly cwd: string
  /** 注入以便测试；缺省时用平台文件管理器真开。 */
  readonly openPath?: (path: string) => void
}

export interface LogsCliResult {
  readonly output: string
  readonly exitCode: number
}

const USAGE = [
  '用法: rivet logs [open [desktop]] [--session <id>] [--json]',
  '',
  '  （无参）          列出本项目当前/最近会话的所有日志落点',
  '  open              在文件管理器中打开会话目录',
  '  open desktop      打开桌面端 sidecar 日志目录',
  '  --session <id>    指定会话（默认取最近写入的那个）',
  '  --json            输出结构化 JSON，便于上报 issue',
].join('\n')

/**
 * 默认 opener。静态导入而非 `require`/动态 import：本模块是 ESM，
 * `require` 在这里是 ReferenceError，而这条分支只在真开文件管理器时才走到，
 * 单测又都注入了 stub —— 惰性加载的写法会让这类错误一路漏到用户手上。
 */
function defaultOpen(path: string): void {
  const { cmd, args } = buildOpenPathCommand(path)
  // windowsHide 必带：detached 在 Windows 上让子进程拥有自己的 console window，
  // 隐藏窗口不能靠「已分离」来默认（openPath 目标虽是 GUI 程序，但 detached spawn
  // 仍会分配控制台）。见 architecture-guards 的 spawn 守卫基线。
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

export function runLogsCLI(args: readonly string[], deps: LogsCliDeps): LogsCliResult {
  let json = false
  let sessionId: string | undefined
  let openTarget: 'session' | 'desktop' | undefined

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--json') { json = true; continue }
    if (a === '--session') {
      const next = args[i + 1]
      // 缺值时不能顺手把下一个 flag 当会话 id——那会静默查错会话。
      if (!next || next.startsWith('-')) {
        return { output: `--session 需要一个会话 id。\n\n${USAGE}`, exitCode: 1 }
      }
      sessionId = next
      i++
      continue
    }
    if (a === 'open') {
      openTarget = args[i + 1]?.toLowerCase() === 'desktop' ? 'desktop' : 'session'
      if (openTarget === 'desktop') i++
      continue
    }
    return { output: `无法识别的参数: ${a}\n\n${USAGE}`, exitCode: 1 }
  }

  // 先按无 sessionId 解析一次，只为拿到会话目录用于兜底查找最近会话。
  const probe = resolveLogLocations({ cwd: deps.cwd })
  const resolvedSession = sessionId ?? latestSessionId(probe.sessionDir)
  const report = resolveLogLocations({
    cwd: deps.cwd,
    ...(resolvedSession ? { sessionId: resolvedSession } : {}),
  })

  if (openTarget) {
    const target = openTarget === 'desktop'
      ? report.locations.find(l => l.id === 'sidecar-logs')?.path
      : report.sessionDir
    if (!target) return { output: '未能解析目标目录。', exitCode: 1 }
    try {
      (deps.openPath ?? defaultOpen)(target)
      return { output: `已打开: ${target}`, exitCode: 0 }
    } catch (err) {
      return { output: `打开失败 (${(err as Error).message})。路径: ${target}`, exitCode: 1 }
    }
  }

  const statuses = statLogLocations(report.locations)

  if (json) {
    return {
      output: JSON.stringify({
        rivetHome: report.rivetHome,
        homeSource: report.homeSource,
        platformDefault: report.platformDefault,
        cwd: report.cwd,
        projectSlug: report.projectSlug,
        ...(report.sessionId ? { sessionId: report.sessionId } : {}),
        sessionDir: report.sessionDir,
        overrides: report.overrides,
        locations: statuses,
      }, null, 2),
      exitCode: 0,
    }
  }

  const hint = resolvedSession
    ? ''
    : '\n\n本项目还没有会话记录（会话专属落点以 <session-id> 占位）。'
  return {
    output: formatLogLocationReport(report, statuses) + hint,
    exitCode: 0,
  }
}
