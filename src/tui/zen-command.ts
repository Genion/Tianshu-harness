/**
 * 禅模式（读专注开局）的显式开关与状态查询——`/zen` 背后的逻辑。
 *
 * ## 为什么单独成文件
 * `slash-commands.ts` 是行数棘轮点名的巨石，注册处只留一层壳；且这里的判定能用
 * 最小桩单测（不必构造整个 TUI app / BootstrapContext）。
 *
 * ## 语义边界（UI 文案不许越界承诺）
 * - `on` / `off` 写的是**配置**：新会话生效。工具面在会话启动期冻结，会话中途换
 *   工具集会改工具指纹、全量重建前缀缓存，所以不做即时相位切换。
 * - 当前**会话**的相位只有两条路：模型调面外工具/`zen_unlock` 自动晋升，或用户
 *   跳过（TUI 是 `/fast`）。`status` 只读不写。
 * - 默认**关**：不显式 `on` 就永远以全量工具面开局、零缓存断点——本命令是那条
 *   显式开启通道，不是默认值的一部分。
 */
import { getZenConfig, setZenConfig } from '../config/zen-config.js'
import type { ZenPhase, ZenPromoteReason } from '../agent/zen-mode.js'

/** 命令要用到的最小能力面——结构化类型，便于单测用桩替换。 */
export interface ZenCommandView {
  /** 提交一行静态系统输出。 */
  commitStatic: (text: string) => void
  /** 读当前会话的相位快照（接线自 `agent.zenController`）。 */
  currentPhase: () => { phase: ZenPhase; promoteReason: ZenPromoteReason | null }
}

const USAGE = '用法：/zen on | off | status —— on/off 写配置（新会话生效）；当前会话想立刻退出读专注用 /fast。'

/**
 * 执行 `/zen [on|off|status]`。恒返回 true（调用方负责 setIsStreaming(false)）。
 * 未知子命令 → 用法提示（不静默当 on 处理——写配置的命令不接受模糊输入）。
 */
export function handleZenCommand(args: readonly string[], view: ZenCommandView): boolean {
  const sub = (args[0] ?? 'status').trim().toLowerCase()

  if (sub === 'status') {
    const { enabled } = getZenConfig()
    const { phase, promoteReason } = view.currentPhase()
    const reasonPart = promoteReason ? `（晋升原因：${promoteReason}）` : ''
    view.commitStatic(
      `禅模式配置：${enabled ? '已开启——新会话以读专注开局' : '关闭（默认）——新会话全量工具面开局'}\n`
      + `当前会话相位：${phase}${reasonPart}`
      + (enabled ? '' : '\n执行 /zen on 开启（新会话生效）。'),
    )
    return true
  }

  if (sub === 'on' || sub === 'off') {
    const enabled = sub === 'on'
    try {
      setZenConfig({ enabled })
      const { phase } = view.currentPhase()
      view.commitStatic(
        enabled
          ? `禅模式已开启：新会话将以读专注开局（只读工具面，首次动手调用自动解锁全量）。\n`
            + `当前会话相位仍为 ${phase}——工具面在会话启动期冻结，配置不回头改已跑起来的会话。`
          : `禅模式已关闭：新会话以全量工具面开局。\n当前会话相位仍为 ${phase}。`,
      )
    } catch (err) {
      view.commitStatic(`禅模式配置写入失败：${(err as Error).message}`)
    }
    return true
  }

  view.commitStatic(USAGE)
  return true
}

/**
 * slash 接线壳：把 TUI 的 app / agent 适配成 {@link ZenCommandView}——注册处
 * 只剩一行调用（`slash-commands.ts` 是零缓冲的点名巨石，接线也一并外置）。
 */
export function runZenSlash(
  trimmed: string,
  app: { commitStatic: (text: string) => void },
  agent: { zenController: { currentPhase: ZenPhase; lastPromoteReason: ZenPromoteReason | null } },
): boolean {
  return handleZenCommand(trimmed.trim().split(/\s+/).slice(1), {
    commitStatic: (text) => app.commitStatic(text),
    currentPhase: () => ({
      phase: agent.zenController.currentPhase,
      promoteReason: agent.zenController.lastPromoteReason,
    }),
  })
}
