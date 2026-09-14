/**
 * Profile 写盘守卫：剥掉 saveConfig 写盘内容里的 profile 覆盖层。
 *
 * profile 层是临时活层（profile.ts「回滚语义：删 profile 文件或换 profile 即
 * 回滚（文件即配置，无状态）」），与 sessionOverlay 的「never persisted here」
 * 同一纪律。此前 saveConfig 把 loadConfig() 的完整合并结果写盘——RIVET_PROFILE
 * （--profile 注入 env）活跃期间，任何一次无关 setter 都会把 profile 覆盖值永久
 * 烘焙进 config.json，此后删 profile、换 profile、删 profile 文件都救不回来。
 *
 * 独立成模块：manager.ts 是点名巨石（行数棘轮只降不升），而「沿 overlay 路径
 * 逐键还原」是纯逻辑、无 manager 内部依赖——persistable 由调用方注入，避免
 * manager ↔ profile-persist 循环 import。
 */
import { resolveProfileName, resolveProfileOverlay } from './profile.js'
import type { Config } from './schema.js'

function jsonDeepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * 沿 profile 覆盖块的路径，把写入对象还原为可持久层（defaults ⊕ user）现值。
 * 只动「写入值与 overlay 贡献值不可区分」的路径（setter 本轮没碰它）；
 * setter 显式改过的路径（写入值 ≠ overlay 值）保持写入值，编辑不被吞掉。
 */
function restorePersistableValues(
  node: Record<string, unknown>,
  overlay: Record<string, unknown>,
  persistable: Record<string, unknown>,
): void {
  for (const [key, ov] of Object.entries(overlay)) {
    if (ov !== null && typeof ov === 'object' && !Array.isArray(ov)) {
      const child = node[key]
      if (child === null || typeof child !== 'object' || Array.isArray(child)) continue
      const perChild = persistable[key]
      restorePersistableValues(
        child as Record<string, unknown>,
        ov as Record<string, unknown>,
        perChild !== null && typeof perChild === 'object' && !Array.isArray(perChild)
          ? perChild as Record<string, unknown>
          : {},
      )
      // 整条路径都还原自 overlay 时容器会变空——{} 深合并等于不存在，删掉保持写盘整洁
      if (Object.keys(child as Record<string, unknown>).length === 0) delete node[key]
      continue
    }
    if (jsonDeepEqual(node[key], ov)) {
      const per = persistable[key]
      if (per === undefined) delete node[key]
      else node[key] = structuredClone(per)
    }
  }
}

/**
 * 写盘前剥掉 profile 覆盖层。读路径不受影响——getter/setter 计算仍走含 profile
 * 的完整合并（manager.ts 的 loadConfig）。
 *
 * @param persistable 可持久视图（defaults ⊕ user，无 profile 层）。由调用方经
 *   manager 的 loadPersistableConfig() 提供；本模块不 import manager，避免循环依赖。
 */
export function unBakeProfileOverlay(toWrite: Config, persistable: Config): void {
  const overlay = resolveProfileOverlay(resolveProfileName())
  if (Object.keys(overlay).length === 0) return
  restorePersistableValues(
    toWrite as unknown as Record<string, unknown>,
    overlay,
    structuredClone(persistable) as unknown as Record<string, unknown>,
  )
}
