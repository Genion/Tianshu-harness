/**
 * 工作区策略 schema（issue #147）——独立成文件是为守住 src/config/schema.ts 的
 * 行数棘轮（沿接缝拆分，见 scripts/source-budgets.manifest.json；同 retry-schema /
 * image-gen-schema 先例）。
 *
 * 两个字段都可选：缺失时任何行为与改造前逐字节一致（未指定目录的新会话仍落到
 * sidecar 的 defaultCwd，即 process.cwd()）。消费方：src/server/workspace.ts。
 */
import { z } from 'zod'

export const workspaceConfigSchema = z.object({
  /** 未指定目录时新建会话的落点（POST /sessions 的 workspaceMode='default'）。留空 = 旧行为。 */
  defaultDir: z.string().optional(),
  /** 临时会话（workspaceMode='scratch'）的隔离根目录。缺省 <rivetHome>/workspace。 */
  scratchDir: z.string().optional(),
}).default({})

export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>
