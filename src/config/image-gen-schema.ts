import { z } from 'zod'

/**
 * 生图模型配置槽（issue #8）——与 `agent.visionModel` 平级同构。
 *
 * 定义放在独立模块而非 `config/schema.ts` 内联，理由同 `retry-schema.ts`
 * 先例：配置面子面沿接缝拆分，不让点名巨石继续膨胀。本模块**零依赖**，
 * 因此 `schema.ts` 可以安全地 import 它（若放实现逻辑则形成循环）。
 *
 * 刻意与 vision 槽的差异（方向反对称：vision 是图→文，生图是文→图）：
 *  - 无 `maxTokens`（vision 用它限描述长度，生图无对应物）
 *  - 有 `size` / `sizeField`：尺寸及其线上字段名。OpenAI 发 `size`，
 *    SiliconFlow 发 `image_size`，值语法相同、只有键名不同
 *  - 有 `timeoutMs`：生图端到端常 10–60s，文本请求量级的默认超时必然失败
 *  - **刻意无 `fallback`**：vision 的 fallback 是「换个模型出同样的描述」；生图
 *    的 fallback 是「再花一次钱生成另一张图」，且从对话里分不清哪张图来自哪个
 *    模型——失败时报错让用户决定，比静默重试烧钱诚实
 *
 * 未配置（`undefined`）是 fail-closed 信号：`generate_image` 据此不注册。
 */
export const imageGenModelSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  /** 提示词前缀（风格/质量约束），拼在用户 prompt 之前。 */
  prompt: z.string().optional(),
  /** 默认尺寸，如 '1024x1024'。缺省则由 provider 默认。 */
  size: z.string().optional(),
  /** 尺寸参数的线上字段名。缺省 = 'size'（OpenAI 形态）。 */
  sizeField: z.enum(['size', 'image_size']).optional(),
  /** 生成超时（毫秒）。文本量级的默认值必然超时。 */
  timeoutMs: z.number().int().positive().optional(),
})

export type ImageGenModelConfigSnapshot = z.infer<typeof imageGenModelSchema>
