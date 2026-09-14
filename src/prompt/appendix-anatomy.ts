import type { CvmInjectionSource } from '../context/pressure-monitor.js'
import type { AppendixPart } from './volatile.js'

/**
 * Appendix 构成分解（cache-log 观测）。
 *
 * 从 volatile.ts 拆出：渲染逻辑与「观测/计量」是两种职责，且 volatile.ts 是
 * 点名巨石（只降不升）。本模块只读 parts、无副作用。
 *
 * 为什么需要它：cache-log 的 appendixChars 只有总量，zenLean 裁了多少在总量里
 * 看不见——会话 ada47b87 的 zen 相位恒 6759 / full 相位恒 7844，那 1085 字符的
 * 差值一度被读成「开关没生效」。cvmChars 就是该开关能省下的上限。
 *
 * 与 appendixChars 的关系：appendixChars ≈ partsChars + <context-update> 包装
 * + ephemeral 前缀 + join 分隔符，故对账时它是下界而非等号。
 */
export interface AppendixAnatomy {
  /** 实际渲染的块数（Top-K 淘汰后） */
  blocks: number
  /** parts 层总字符 = cvmChars + keepChars（恒等式，可外部自校验） */
  partsChars: number
  /** 带 CvmInjectionSource 的块字符合计 —— zenLean 的作用面 */
  cvmChars: number
  /** 无 source 的块字符合计（git-status / recent-commits / 计划指针等 keep-list） */
  keepChars: number
  /** CVM 块按 source 分解（字符） */
  cvmBySource: Partial<Record<CvmInjectionSource, number>>
}

/** 汇总 parts 的字符构成。纯函数：不读 ctx、无副作用。 */
export function summarizeAppendixParts(parts: readonly AppendixPart[]): AppendixAnatomy {
  let cvmChars = 0
  let keepChars = 0
  const cvmBySource: Partial<Record<CvmInjectionSource, number>> = {}
  for (const p of parts) {
    if (p.source) {
      cvmChars += p.content.length
      cvmBySource[p.source] = (cvmBySource[p.source] ?? 0) + p.content.length
    } else {
      keepChars += p.content.length
    }
  }
  return { blocks: parts.length, partsChars: cvmChars + keepChars, cvmChars, keepChars, cvmBySource }
}
