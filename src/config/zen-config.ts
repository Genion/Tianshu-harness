/**
 * 禅模式（读专注开局）的配置读写——`tools.zen.enabled` 的唯一写入口。
 *
 * 为什么单独成文件：`config/manager.ts` 是行数棘轮点名的巨石（零缓冲，+1 即触警），
 * 而 zen 开关只有两个函数、依赖面仅 loadConfig/saveConfig，独立成可单测的小模块
 * 比在巨石里加一段更合适；调用方（服务端 /config/zen 路由、TUI `/zen`）直接从这里取。
 */
import { loadConfig, saveConfig } from './manager.js'

export interface ZenConfigSnapshot {
  /** 禅模式开关。未配置即为 false——读专注开局是用户显式 opt-in。 */
  enabled: boolean
}

/** 禅模式开关快照（未配置与显式 false 同义：都是全量工具面开局）。 */
export function getZenConfig(): ZenConfigSnapshot {
  return { enabled: loadConfig().tools.zen?.enabled === true }
}

/**
 * 持久化 `tools.zen.enabled`——用户显式开启/关闭禅模式的唯一写入口
 * （TUI `/zen on|off` 与桌面端设置开关共用同一条）。
 *
 * **新会话生效**：工具面在会话启动期冻结（会话中途改会让工具指纹变化、全量重建
 * 前缀缓存，永远不值），bootstrap 在新会话装配时读 config——已开的会话不受影响，
 * UI 文案必须如实这么说，不能暗示当前会话立刻切换相位。
 *
 * 只写 enabled，其余档位（face / faceMode / timeoutSteps / triage /
 * appendixLean）保持用户既有配置，不被本函数抹掉。
 */
export function setZenConfig(input: { enabled?: unknown }): ZenConfigSnapshot {
  if (input.enabled === undefined) throw new Error('enabled is required')
  if (typeof input.enabled !== 'boolean') throw new Error('enabled must be a boolean')
  const cfg = loadConfig()
  cfg.tools.zen = { ...(cfg.tools.zen ?? {}), enabled: input.enabled }
  saveConfig(cfg)
  return { enabled: input.enabled }
}
