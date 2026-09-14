/**
 * worker-repair-route — 无历史 JSON 修复通道的准入门（2026-09-13 假报告事故）。
 *
 * 事故链（现场）：一个审查 worker 跑了 15 轮、31 次工具调用，终轮产出探索散文
 * 而非 verdict JSON → 主 parse 失败 → 落进 `repairWithJsonMode`。那条通道是
 * **无历史单发**：模型只看得到修复指令、工单 ID、结果结构，加上一条输出的尾部
 * 8000 字符（`worker-prompts.ts:373`），看不到自己的工具调用记录。在"必须产出
 * 合法 JSON"与"不得编造"的双重约束下，它如实写下"我没有工具调用记录、没有仓库
 * 访问"——这段合法 JSON 通过 parse 后被当作 worker 的正式结论，直接渲染进
 * 提交后审查的 advisory（`review-coordinator-deps.ts:211` → `review-router.ts:305`）。
 *
 * 系统自己早就判过这条通道在该场景有害：`worker-session.ts:731-736` 的注释写着
 * `context-free single-shot`、`actively harmful here`、`Never repair.`——但那个豁免
 * 只挂在 max-turns 入口，探索散文落回旧路径时仍会进入。
 *
 * 本模块把准入判据抽成纯函数：**探索过就不许走无历史通道**（改用其后那条带完整
 * 会话历史的 AgentLoop 修复；后者失败才落到诚实阶梯）。
 */

/**
 * 是否允许使用「无历史单发」JSON 修复通道。
 *
 * - `toolUseCount === 0`：worker 没有任何探索痕迹，无历史可丢，允许（这是该通道
 *   本来的适用场景：廉价模型输出格式不合规）。
 * - `toolUseCount > 0`：探索过——无历史通道会让模型看不见自己的工具调用，只能
 *   编造或如实报告"我没上下文"，两者都会污染结果契约。**不许**。
 * - `forceJsonRepair === false`：provider 明确拒绝 response_format，通道本就关闭。
 * - `abortLatched === true`：已中止，不再花任何 API（由上层 salvage 阶梯接管）。
 *
 * @returns true 表示允许走无历史 JSON 修复
 */
export function shouldUseContextFreeRepair(input: {
  toolUseCount: number
  /** 可选：与 config 上的同名字段一致（undefined 表示未启用，按 false 处理）。 */
  forceJsonRepair?: boolean
  abortLatched: boolean
}): boolean {
  if (!input.forceJsonRepair) return false
  if (input.abortLatched) return false
  return input.toolUseCount === 0
}

/** 收尾轮输出在 max_tokens 处截断的判定（onStopReason 归一值）。
 *  openai-client 的 mapFinishReason 把 finish_reason='length' 映射为
 *  'max_tokens'（anthropic 原生同值）。命中即文本必然未闭合、parse 必失败，
 *  且同预算的修复轮只会再撞同一面墙——这个事实必须透传到失败结果里
 *  （2026-09-13 两例 review worker json_parse 事故：现场只剩「JSON malformed」，
 *  真正的截断原因被 salvage 的笼统 summary 吞掉）。 */
export function isTruncationStopReason(reason: string | undefined): boolean {
  if (!reason) return false
  const r = reason.toLowerCase()
  return r === 'max_tokens' || r === 'length'
}

/** 收尾轮截断的终局标记——附在 salvage/blocked 结果的 risks 上。 */
export const FINALIZE_TRUNCATION_RISK =
  'finalize output was truncated at max_tokens — the report needed a larger output budget than the profile allows (raise the profile defaultMaxTokens or order.budget.maxTokens)'

/** 截断发生时的结果包装：把截断事实追加进 risks；无截断原样返回。 */
export function withTruncationRisk<T extends { risks: string[] }>(result: T, truncated: boolean): T {
  return truncated ? { ...result, risks: [...result.risks, FINALIZE_TRUNCATION_RISK] } : result
}
