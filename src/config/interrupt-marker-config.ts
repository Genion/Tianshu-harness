/**
 * 打断留痕开关：用户 Stop 时保留 partial 输出并追加 `[interrupted]` system-reminder。
 *
 * 默认开。关闭方式（任一）：config `agent.interruptMarker=false`；env `RIVET_INTERRUPT_MARKER=0/false/off/no`。
 * 两条通道都要：env 适合终端用户和 CI 临时覆盖；config 是桌面端唯一可行的
 * 通道——GUI 启动的 sidecar 继承不到 shell 环境变量。
 */

/**
 * 打断留痕是否启用。
 *
 * @param configValue config.json 的 `agent.interruptMarker`。undefined =
 *   调用方没有 config 上下文（如独立装配的测试），按默认开处理。
 */
export function isInterruptMarkerEnabled(configValue?: boolean): boolean {
  if (configValue === false) return false
  const raw = process.env.RIVET_INTERRUPT_MARKER
  if (raw === undefined) return true
  const lower = raw.trim().toLowerCase()
  return !(lower === '0' || lower === 'false' || lower === 'off' || lower === 'no')
}
