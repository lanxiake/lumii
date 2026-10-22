import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../../../main/kernel/events'
import { recordUsage, queryUsage } from './store'
import type { UsageService } from './service-api'
import { S } from '../../../main/kernel/services'

/**
 * 用量统计扩展。
 *
 * ## 架构定位
 *
 * 内建插件，可禁用。禁用后：
 * - LLM 用量不再记录（~/.lumii/usage/*.jsonl 不再写入）
 * - 设置页的用量图表无新数据
 * - 查询 API 仍能读取历史记录
 *
 * ## 依赖与时序
 *
 * - **Agent Runtime 事件**：订阅 `llm:after-response` 事件记录用量
 * - **激活时机**：插件注册时立即订阅事件（懒订阅，不阻塞启动）
 * - **无运行时依赖**：用量记录是纯文件写入（JSONL），不依赖数据库或其他服务
 *
 * ## 核心逻辑
 *
 * 1. **事件订阅式记录**：
 *    - 插件启动时订阅 `llm:after-response` 事件
 *    - 每次 LLM 返回后，提取 usage 明细（promptTokens / completionTokens / cacheRead / cacheWrite）
 *    - 调用 `recordUsage` 追加写入 `~/.lumii/usage/YYYY-MM.jsonl`
 *    - 只记录真实 usage（服务商返回的 token 明细），估算值不入库
 *
 * 2. **自动清理**：
 *    - 插件禁用时，事件订阅自动解除（`ctx.on` 的取消注册在 scope 清理时自动调用）
 *    - 无需手动管理订阅生命周期
 *
 * 3. **存储协议**（`usage-store.ts`）：
 *    - JSONL 格式，一行一次 LLM 调用
 *    - 按月分片（本地时间），单文件量级小
 *    - 字段包含：ts / model / promptTokens / completionTokens / cacheReadTokens / cacheWriteTokens / costYuan / sessionKey
 *
 * 4. **花费估算**：
 *    - 写入时按当前价目表估算 costYuan（人民币元）
 *    - 查询时按调用时间戳重新估算（价格可能已更新）
 *    - 价格未知时 costYuan 为 undefined，UI 显示「—」
 *
 * ## P1 vs P2
 *
 * - **P1**（包装式）：只声明插件，用量记录逻辑仍在 `bridge-agent-instance-events.ts` L873
 * - **P2**（事件订阅式，当前实现）：用量记录逻辑迁移到插件内，订阅 `llm:after-response` 事件
 *   - 禁用插件 = 不订阅事件，用量不再记录（真正的热插拔）
 *   - 原调用点（`bridge-agent-instance-events.ts` L873）**必须删除**，否则重复记录
 *
 * ## 迁移检查清单
 *
 * - [x] 创建插件文件（`extensions/usage.ts`）
 * - [x] 订阅 `llm:after-response` 事件
 * - [x] 实现用量记录逻辑（复用 `recordUsage` 函数）
 * - [x] 删除原调用点（`bridge-agent-instance-events.ts` L873-881）
 * - [x] 注册到 `BUILTIN_EXTENSIONS`
 * - [x] 事件类型添加 sessionKey 字段
 * - [x] 事件发射点传递 sessionKey
 * - [ ] 验证：禁用插件后用量不再记录
 * - [ ] 验证：启用插件后用量正常记录
 */
export const usageExtension = {
  manifest: {
    id: 'com.lumii.usage',
    name: '用量统计',
    version: '0.1.0',
    description: 'LLM 调用用量与花费的本地记录（~/.lumii/usage/*.jsonl）',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.usage',
    provides: ['usage-recording'],
    apply(ctx) {
      ctx.provide(S.usage, { query: (query) => queryUsage(query) } satisfies UsageService)

      // 订阅 LLM 响应事件，记录用量
      ctx.on('llm:after-response', (event) => {
        // 只记录成功的调用 + 有真实 usage 明细的（服务商返回 token 数）
        // 估算值不入库，否则花费统计失真
        if (event.success && event.usage && event.modelId) {
          void recordUsage({
            model: event.modelId,
            promptTokens: event.usage.inputTokens ?? 0,
            completionTokens: event.usage.outputTokens ?? 0,
            cacheReadTokens: event.usage.cacheRead,
            cacheWriteTokens: event.usage.cacheWrite,
            sessionKey: event.sessionKey,
            ts: event.at,
          })
        }
      })

      ctx.log.info('用量统计插件已启动（订阅 llm:after-response 事件）')

      // 清理逻辑：ctx.on 的取消订阅已由 scope 自动管理，无需手动清理
      // 禁用插件时，事件订阅会自动解除
    },
  }),
}
