import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Tool } from './types.js'
import { expandHome } from '../platform.js'

export interface OpenPathCommand {
  cmd: string
  args: string[]
}

function normalizeOpenTarget(path: string, platform: NodeJS.Platform): string {
  const expanded = expandHome(path)
  if (platform === 'win32' && /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(expanded)) {
    return expanded
  }
  return resolve(expanded)
}

export function buildOpenPathCommand(path: string, platform: NodeJS.Platform = process.platform): OpenPathCommand {
  const target = normalizeOpenTarget(path, platform)
  if (platform === 'win32') {
    // 不用 `cmd.exe /c start`：cmd 对参数做二次解析，路径中的 & | % ^ 等元字符
    // 会被重新解释（注入面）。改用 PowerShell Start-Process，路径作为 -FilePath
    // 单引号字面串传入（单引号内 & | % ^ $ 全不解释，'' 转义内嵌单引号）。
    //
    // 注意: Start-Process 没有 -LiteralPath 参数 (那是 Get-Item 等 Item cmdlet
    // 的参数)。之前版本误用 -LiteralPath 导致 Windows 下"打开文件/文件夹"
    // 永远失败报 "找不到与参数名称 LiteralPath 匹配的参数"。
    //
    // explorer/Start-Process 对正斜杠路径不友好（前端 toAbsolute 在 cwd 含 '/'
    // 时会拼出 'C:/Users/...'，explorer 会静默失败），统一转反斜杠。
    const winTarget = target.replace(/\//g, '\\')
    const literal = `'${winTarget.replace(/'/g, "''")}'`
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath ${literal}`],
    }
  }
  if (platform === 'darwin') {
    return { cmd: 'open', args: [target] }
  }
  return { cmd: 'xdg-open', args: [target] }
}

/** Build a command that reveals a file in the platform file manager. */
export function buildRevealCommand(path: string, platform: NodeJS.Platform = process.platform): OpenPathCommand {
  const target = normalizeOpenTarget(path, platform)
  if (platform === 'win32') {
    // explorer /select,"C:\path\to\file" — invoke through PowerShell so spaces
    // and shell metacharacters are not re-interpreted. Single-quote escaping
    // handles the rare embedded single quote.
    //
    // explorer 对正斜杠路径静默失败（前端可能传 'C:/Users/...'），统一转反斜杠。
    const winTarget = target.replace(/\//g, '\\')
    const literal = `'${winTarget.replace(/'/g, "''")}'`
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', `explorer /select,${literal}`],
    }
  }
  if (platform === 'darwin') {
    return { cmd: 'open', args: ['-R', target] }
  }
  // Linux: no universal "select file" API; open the containing directory.
  return { cmd: 'xdg-open', args: [dirname(target)] }
}

export const OPEN_PATH_TOOL: Tool = {
  definition: {
    name: 'open_path',
    description: `在用户操作系统中打开文件或目录。

用于用户可见文件，如生成的图片、SVG、PDF 或文件夹。接受外部路径（桌面、下载、挂载盘、Windows 路径），通过直接启动 OS 打开器避免 shell 引用问题。

示例：
Good: open_path(path="~/Desktop/tianshu-logo.svg")
Good: open_path(path="H:\\zhuomian\\白嫖gpt")
Bad: 用 bash explorer/open/start 命令加手写 shell 引号`,
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '绝对路径或 ~ 相对路径，要打开的文件/目录。可在项目之外。' },
      },
      required: ['path'],
    },
  },

  async execute(params) {
    const raw = params.input.path
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      return { content: '错误：path 为必填项', isError: true }
    }
    const target = resolve(expandHome(raw.trim()))
    if (!existsSync(target)) {
      return { content: `错误：路径不存在：${target}`, isError: true }
    }
    const command = buildOpenPathCommand(target)

    return new Promise((resolveResult) => {
      const child = spawn(command.cmd, command.args, { detached: true, stdio: 'ignore', windowsHide: true })
      child.on('error', (err) => {
        resolveResult({ content: `打开 ${target} 时出错：${err.message}`, isError: true })
      })
      child.on('spawn', () => {
        child.unref()
        resolveResult({ content: `已打开：${target}` })
      })
    })
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
