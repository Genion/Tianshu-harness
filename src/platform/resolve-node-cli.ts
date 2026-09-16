/**
 * Resolve bare `npx` / `npm` to `node + *-cli.js` so stdio spawns work when
 * shell is forced off (MCP SDK StdioClientTransport) and Windows GUI PATH
 * lacks `npx.cmd`.
 *
 * Layout mirrors the official Node archive / fetch-node-runtime bundling:
 *   Windows: <nodeDir>/node_modules/npm/bin/{npx,npm}-cli.js
 *   Unix:    <nodeDir>/lib/node_modules/npm/bin/{npx,npm}-cli.js
 */
import { existsSync } from 'node:fs'
import { basename, win32 as winPath, posix as posixPath } from 'node:path'

export interface ResolveNodeCliDeps {
  execPath?: string
  platform?: NodeJS.Platform
  existsSync?: (path: string) => boolean
}

export interface ResolvedStdioCommand {
  command: string
  args: string[]
}

function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? winPath : posixPath
}

function bareName(command: string): string {
  const base = basename(command.replace(/\\/g, '/'))
  // Strip Windows .cmd/.bat/.exe so "npx.cmd" still matches.
  return base.replace(/\.(cmd|bat|exe)$/i, '').toLowerCase()
}

function cliCandidates(kind: 'npx' | 'npm', nodeDir: string, platform: NodeJS.Platform): string[] {
  const p = pathApi(platform)
  const file = kind === 'npx' ? 'npx-cli.js' : 'npm-cli.js'
  if (platform === 'win32') {
    return [p.join(nodeDir, 'node_modules', 'npm', 'bin', file)]
  }
  // Packaged desktop: node binary is flat in targetDir, npm under lib/.
  // Official Node archive: binary in bin/, npm under ../lib/.
  return [
    p.join(nodeDir, 'lib', 'node_modules', 'npm', 'bin', file),
    p.join(p.dirname(nodeDir), 'lib', 'node_modules', 'npm', 'bin', file),
    p.join(nodeDir, 'node_modules', 'npm', 'bin', file),
  ]
}

/**
 * If `command` is npm/npx (bare or *.cmd), rewrite to the hosting Node binary
 * plus the matching cli.js. Unknown commands / missing cli → pass through.
 */
export function resolveNpmCliCommand(
  command: string,
  args: string[] = [],
  deps: ResolveNodeCliDeps = {},
): ResolvedStdioCommand {
  const name = bareName(command)
  if (name !== 'npx' && name !== 'npm') {
    return { command, args: [...args] }
  }

  const execPath = deps.execPath ?? process.execPath
  const platform = deps.platform ?? process.platform
  const exists = deps.existsSync ?? existsSync
  const p = pathApi(platform)
  const nodeDir = p.dirname(execPath)

  for (const candidate of cliCandidates(name, nodeDir, platform)) {
    if (exists(candidate)) {
      return { command: execPath, args: [candidate, ...args] }
    }
  }

  return { command, args: [...args] }
}

/**
 * 基座 PATH 读不到时的系统目录兜底。
 *
 * 为什么需要：npx/npm 解析与安装包时要 spawn `cmd.exe`（Windows）或 `/bin/sh`，
 * 它们在系统目录里，不在 node 目录里。旧实现只把 PATH 写成 nodeDir，于是「基座
 * 没给 PATH」会静默退化成「子进程只能看到一个目录」，失败方式是秒退 + 一句
 * -32000，完全看不出根因（issue #149 的对照实验：PATH 只有 node 目录 → npx
 * 全部 `spawn cmd ENOENT`；补上 System32 后全部成功）。
 *
 * 基座 PATH 的完整性由注入的 getDefaultEnvironment 决定——MCP SDK 的
 * DEFAULT_INHERITED_ENV_VARS 白名单在版本间动过（1.29.0 的 win32 列表含 PATH，
 * 更早的版本不含），本仓库不该把子进程能否启动押在第三方的白名单上。
 *
 * 读 SystemRoot 而不是硬写 C:\Windows：装到非系统盘的机器上硬写会让兜底本身失效。
 * POSIX 不兜底——那里 PATH 缺失罕见，且猜 /bin:/usr/bin 反而可能覆盖掉调用方的
 * 精心配置。
 */
function systemPathFallback(platform: NodeJS.Platform, base: Record<string, string>): string[] {
  if (platform !== 'win32') return []
  const root = (base.SystemRoot ?? base.SYSTEMROOT ?? process.env.SystemRoot ?? 'C:\\Windows')
    .replace(/[\\/]+$/, '')
  return [`${root}\\System32`, root, `${root}\\System32\\Wbem`]
}

/**
 * Build an env object for MCP stdio transports: always explicit, with the
 * hosting Node directory prepended to PATH so npx-cli can find the same node.
 * User-supplied env is merged, but nodeDir is written last onto PATH.
 */
export function buildStdioEnvWithNodePath(
  userEnv?: Record<string, string>,
  deps: ResolveNodeCliDeps & {
    getDefaultEnvironment?: () => Record<string, string>
  } = {},
): Record<string, string> {
  const getDefault = deps.getDefaultEnvironment
    ?? (() => {
      const out: Record<string, string> = {}
      for (const key of ['PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
        const v = process.env[key]
        if (v !== undefined) out[key] = v
      }
      return out
    })
  const base = getDefault()
  const user = userEnv ?? {}
  const execPath = deps.execPath ?? process.execPath
  const platform = deps.platform ?? process.platform
  const p = pathApi(platform)
  const pathSep = platform === 'win32' ? ';' : ':'
  const nodeDir = p.dirname(execPath)
  const pathRest = user.PATH ?? user.Path ?? base.PATH ?? base.Path ?? ''
  const fallback = pathRest ? [] : systemPathFallback(platform, base)
  return {
    ...base,
    ...user,
    PATH: [nodeDir, ...(pathRest ? [pathRest] : fallback)].join(pathSep),
  }
}
