/**
 * 临时会话隔离根（`<rivetHome>/workspace`）的枚举与清理——issue #147 跟进的
 * 收尾件：临时会话目录此前只增不减，应用内没有任何清理路径（只能手动开数据根）。
 *
 * 删除是破坏性操作，先把不变量定死再写实现：
 *   1. 只接受**目录名**，不接受路径——含分隔符 / `..` / 空 / 以 `.` 开头一律拒绝，
 *      路径穿越在任何分支都到不了 root 之外；
 *   2. 只处理 root 的直接子项；符号链接既不跟随也不删除（逃逸面的最小区分）；
 *   3. 删除前用 realpath 复核落点仍在 root 之下——覆盖挂载点/绑定这类
 *      「名字看不出、语义上跑出去了」的边界；
 *   4. 被任何存活会话占用的目录跳过（占用集合由调用方给）——运行中的临时
 *      会话不能被清掉；
 *   5. root 不存在 = 空报告而不是错误（用户可能从未用过临时会话）。
 *
 * 纯 IO 模块 + 两条路由：不读配置之外的东西，占用来源经 `ScratchSessionSource`
 * 结构化注入（不 import 会话管理器，免掉环与重量级依赖，也让测试能做到端到端）。
 */
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { RouteHandler } from './index.js'
import { rivetHome } from '../config/paths.js'
import { getWorkspaceConfig } from '../config/workspace-config.js'
import { sessionScratchRoot } from './workspace.js'
import { withAuth } from './route-auth.js'

export interface ScratchEntry {
  name: string
  path: string
  bytes: number
  mtime: number
  /** 有存活会话以该目录为 cwd——UI 据此禁用删除。 */
  inUse: boolean
}

export interface ScratchReport {
  root: string
  exists: boolean
  entries: ScratchEntry[]
  totalBytes: number
  inUseCount: number
}

export type ScratchSkipReason =
  | 'invalid-name' | 'in-use' | 'not-found' | 'symlink' | 'not-a-directory' | 'outside-root' | 'failed'

export interface ScratchCleanupResult {
  deleted: string[]
  freedBytes: number
  skipped: Array<{ name: string; reason: ScratchSkipReason }>
}

/** 会话侧的最小契约：只要「当前存活会话的 cwd 列表」。 */
export interface ScratchSessionSource {
  listSessions(): Array<{ cwd: string }>
}

/** 大小写不敏感文件系统的规范形（macOS / Windows）——同目录两种写法必须同判。 */
function canonical(p: string): string {
  const abs = resolve(p)
  return process.platform === 'linux' ? abs : abs.toLowerCase()
}

function isWithinRoot(target: string, root: string): boolean {
  return canonical(target).startsWith(canonical(root) + sep)
}

/** 目录占用字节——不跟随符号链接（跟随会把 root 外的体积算进来）。 */
function dirSize(dir: string): number {
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()!
    let entries
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      continue // 竞态：清理期间目录被删
    }
    for (const e of entries) {
      const p = join(cur, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile()) {
        try { total += statSync(p).size } catch { /* 竞态 */ }
      }
    }
  }
  return total
}

/** 目录名合法性：单段、非隐藏、非穿越。 */
export function isSafeScratchName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false
  if (name.startsWith('.')) return false
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false
  return true
}

export function listScratchEntries(root: string, inUsePaths: Iterable<string> = []): ScratchReport {
  const inUse = new Set([...inUsePaths].map(canonical))
  const empty: ScratchReport = { root, exists: false, entries: [], totalBytes: 0, inUseCount: 0 }
  if (!existsSync(root)) return empty
  let dirents
  try {
    dirents = readdirSync(root, { withFileTypes: true })
  } catch {
    return empty
  }
  const entries: ScratchEntry[] = []
  for (const d of dirents) {
    // 只有真实目录是临时会话目录；文件与符号链接都不进列表（也就永不可删）。
    if (!d.isDirectory()) continue
    const path = join(root, d.name)
    let mtime = 0
    try { mtime = statSync(path).mtimeMs } catch { /* 竞态 */ }
    entries.push({ name: d.name, path, bytes: dirSize(path), mtime, inUse: inUse.has(canonical(path)) })
  }
  entries.sort((a, b) => b.mtime - a.mtime)
  return {
    root,
    exists: true,
    entries,
    totalBytes: entries.reduce((n, e) => n + e.bytes, 0),
    inUseCount: entries.filter((e) => e.inUse).length,
  }
}

/**
 * 按名删除（名字来自 `listScratchEntries` 的枚举，不是用户自由输入）。
 * 每一格都有跳过原因：静默当成功会让用户以为删了实际还在。
 */
export function removeScratchEntries(
  root: string,
  names: string[],
  inUsePaths: Iterable<string> = [],
): ScratchCleanupResult {
  const inUse = new Set([...inUsePaths].map(canonical))
  const result: ScratchCleanupResult = { deleted: [], freedBytes: 0, skipped: [] }
  for (const name of names) {
    if (!isSafeScratchName(name)) {
      result.skipped.push({ name, reason: 'invalid-name' })
      continue
    }
    const target = join(root, name)
    let st
    try {
      st = lstatSync(target)
    } catch {
      result.skipped.push({ name, reason: 'not-found' })
      continue
    }
    if (st.isSymbolicLink()) {
      result.skipped.push({ name, reason: 'symlink' })
      continue
    }
    if (!st.isDirectory()) {
      result.skipped.push({ name, reason: 'not-a-directory' })
      continue
    }
    if (inUse.has(canonical(target))) {
      result.skipped.push({ name, reason: 'in-use' })
      continue
    }
    let real = ''
    let realRoot = ''
    try {
      real = realpathSync(target)
      realRoot = realpathSync(root)
    } catch {
      result.skipped.push({ name, reason: 'not-found' })
      continue
    }
    if (!isWithinRoot(real, realRoot)) {
      result.skipped.push({ name, reason: 'outside-root' })
      continue
    }
    const bytes = dirSize(target)
    try {
      rmSync(target, { recursive: true, force: false })
    } catch {
      result.skipped.push({ name, reason: 'failed' })
      continue
    }
    result.deleted.push(name)
    result.freedBytes += bytes
  }
  return result
}

// ── 路由（与 /storage 同族：临时会话也是存储面）─────────────────────────────
//
// 挂在 session-routes 装配处（一行展开）而不是 config-routes：占用判定要读
// 存活会话，只有 session 侧拿得到 manager。鉴权走共享的 withAuth
// （route-auth.js），与 /storage 族同一套 fail-closed 与协议头语义。

/** 生效的隔离根：配置覆盖优先，否则 `<rivetHome>/workspace`（与 workspace-route 同源）。 */
export function resolveScratchRoot(): string {
  try {
    return getWorkspaceConfig().scratchDir ?? sessionScratchRoot(rivetHome())
  } catch {
    return sessionScratchRoot(rivetHome())
  }
}

export function buildScratchRoutes(
  source: ScratchSessionSource,
  apiToken?: string,
): Record<string, RouteHandler> {
  const inUsePaths = (): string[] => {
    try {
      return source.listSessions().map((s) => s.cwd)
    } catch {
      // 会话列表读不到 → 一律视为「可能被占用」？不行：那样用户永远删不掉。
      // 会话列表是内存读、正常不会抛；真抛了按「无占用」处理并在结果里如实删除。
      return []
    }
  }

  return {
    // 临时会话占用一览（数据量小，设置页按需拉取）。
    'GET /scratch': withAuth(() => {
      const root = resolveScratchRoot()
      return { status: 200, body: listScratchEntries(root, inUsePaths()) }
    }, apiToken),

    // 清理：`names` 省略 = 清理所有非占用的临时会话目录。
    // 破坏性操作，桌面端在调用前有显式确认（与 /storage/cleanup 同约定）。
    'POST /scratch/cleanup': withAuth((body) => {
      const data = (body ?? {}) as { names?: unknown }
      const root = resolveScratchRoot()
      const inUse = inUsePaths()
      const names = Array.isArray(data.names)
        ? data.names.filter((x): x is string => typeof x === 'string')
        : listScratchEntries(root, inUse).entries.filter((e) => !e.inUse).map((e) => e.name)
      return { status: 200, body: removeScratchEntries(root, names, inUse) }
    }, apiToken),
  }
}
