/**
 * `rivet --version` 的版本解析——不依赖 tui/updater.ts。
 *
 * 为什么不用 updater 的 `detectInstallRoot` / `getCurrentVersion`（2026-09-16
 * P0-2）：`tui/updater.ts` 静态 import undici（`ProxyAgent`）与镜像/代理解析，
 * 一个 --version 不值得拉起 ~1MB 的闭包。这里用 node:fs 重实现同一语义：
 * 从 argv[1]（bin 路径）真实路径向上找最近的、带 `version` 字段的 package.json。
 *
 * 2026-09-16 晚：updater 的 `detectInstallRoot` / `getCurrentVersion` 已反过来委托
 * 本模块——原来的「找到第一个 package.json 就返回」会被工作区 `dist/package.json`
 * （只有 `{"type":"module"}`，由 stage-runtime-deps.js 为脱离仓库分发而写）劫持，
 * 于是 root 变成 `<pkg>/dist`：欢迎页版本号消失、更新检查拿不到包名。两处不再各自
 * 留一份实现；本地开发与发布包都拿真版本。
 * 找不到时同样回退 `unknown`，保持输出形状不变。
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 从脚本路径（默认 argv[1]）向上找最近的带 version 的 package.json 目录。 */
export function findInstallRoot(scriptPath: string | undefined = process.argv[1]): string | null {
  if (!scriptPath) return null
  let dir: string
  try {
    dir = dirname(realpathSync(scriptPath))
  } catch {
    dir = dirname(scriptPath)
  }
  for (let i = 0; i < 20; i++) {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const parsed = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: unknown }
        if (typeof parsed.version === 'string' && parsed.version.length > 0) return dir
      } catch {
        // 坏包声明不终止查找——继续向上（与版本兜底同一个 fail-open 姿态）。
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** 读取 install root 的 version 字段；失败返回 null。 */
export function readInstallVersion(root: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : null
  } catch {
    return null
  }
}

/** `tianshu-tui vX.Y.Z\n` —— main.ts 与 launcher 共用的 --version 输出。 */
export function formatVersionLine(scriptPath?: string): string {
  const root = findInstallRoot(scriptPath)
  const version = root ? readInstallVersion(root) : null
  return `tianshu-tui v${version ?? 'unknown'}\n`
}
