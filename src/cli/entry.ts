/**
 * rivet CLI launcher（package.json `bin.rivet`）——P0-1/P0-2 CLI 启动优化。
 *
 * 2026-09-16 之前 bin 直接指向 dist/main.js：ESM 的静态 import 先于模块体执行，
 * 所以 `--version` / `--help` / `config` / `serve` 等所有路径都要先付 main.ts 顶部
 * 87 个静态 import 的整图成本（实测 8.3MB / 114 chunks、~1.0-1.2s CPU、117MB RSS）。
 *
 * 本入口做三件事：
 *   1. P0-1：在加载任何重模块之前启用 Node V8 编译缓存（Node 22.1+）。
 *      桌面 sidecar 早已由 Rust 注入 NODE_COMPILE_CACHE（lib.rs:3082，实测
 *      -35%），CLI 此前没有；缓存目录不可写时 fail-open，不阻塞启动。
 *   2. P0-2：`--help/--version` 直接输出（只依赖 help-text/version 两个叶子），
 *      不加载 main。
 *   3. 把 TTY 前的子命令交给 cli/early-routing（config/provider/serve/
 *      sessions/--list/browser/logs/web），命中即结束；未命中才动态 import main。
 *
 * main.ts 仍可直跑（桌面 sidecar / benchmark / 开发）且行为不变——它内部同样
 * 调用 early-routing，保证两条入口的路由与 --profile/--trust 副作用一致。
 */
import { mkdirSync } from 'node:fs'
import { enableCompileCache } from 'node:module'
import { join } from 'node:path'
import { applyEarlyCliEnv, routeEarlyCli } from './early-routing.js'
import { HELP_TEXT } from './help-text.js'
import { formatVersionLine } from './version.js'
import { rivetHome } from '../config/paths.js'

/** 编译缓存目录与桌面端同级：<RIVET_HOME>/cli/compile-cache（按内容哈希自动失效）。 */
function enableCliCompileCache(): void {
  if (typeof enableCompileCache !== 'function') return
  // 桌面壳 spawn sidecar 前已注入 NODE_COMPILE_CACHE（lib.rs::spawn_from_spec）：
  // 进程启动即已启用，再调一次只会拿到 already-enabled，且没必要创建
  // <RIVET_HOME>/cli/compile-cache 这个用不到的目录。
  if (process.env.NODE_COMPILE_CACHE) return
  try {
    const dir = join(rivetHome(), 'cli', 'compile-cache')
    mkdirSync(dir, { recursive: true })
    enableCompileCache(dir)
    return
  } catch {
    // 持久目录不可写（只读盘/权限/ACL）→ 退到 Node 默认临时缓存目录。
    // 两者都失败时 fail-open：CLI 绝不能因为性能优化而起不来。
  }
  try {
    enableCompileCache()
  } catch {
    // 完全不可用时 Node 侧本就会静默跳过。
  }
}

enableCliCompileCache()

const args = process.argv.slice(2)

// --help / --version 在任何重模块加载前处理（与 main.ts 的输出逐字一致）。
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(HELP_TEXT)
  process.exit(0)
}
if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write(formatVersionLine())
  process.exit(0)
}

// 早期副作用（--profile / --trust / --untrust）必须先于任何配置读取；
// routeEarlyCli 命中时在这里结束，未命中时 main.ts 会幂等地再执行一次。
await applyEarlyCliEnv(args)

if (await routeEarlyCli(args)) {
  // 子命令已完成（serve 等长驻路径在处理器内部自行返回）。
} else {
  await import('../main.js')
}
