import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../../../main/kernel/events'
import { S } from '../../../main/kernel/services'

/**
 * 代聊扩展（微信消息盯梢 + 自动回复）。
 *
 * ## 架构定位
 *
 * 内建插件，可禁用。禁用后：
 * - 微信消息盯梢循环不启动（`wechat-watch` cron 不注册/禁用）
 * - 代聊 Agent 定义仍播种到 `~/.lumii/config/agents.json`（用户可自己删）
 * - 渠道策略配置保留（`~/.lumii/channel/channel-policies.json` 不清理）
 *
 * ## 依赖与时序
 *
 * - **Bridge 与数据库**: 通过 `S.bridge` 服务获取 bridge 与数据库适配器
 * - **激活时机**: 等 `app:ready`（bridge 在 S7 初始化，代聊需要它的 `driveTurn`）
 *
 * ## 核心逻辑
 *
 * 1. **盯梢循环** (`wechat-watch-tick.ts`):
 *    - 15 秒一拍，零 token 读库（`wechat-local.poll_new`）
 *    - 有新消息 → 按渠道策略（`channel-policies.json`）决定行动
 *    - `notify` → 系统通知；`draft` → 起草待审；`auto` → 直接发送
 *
 * 2. **代聊 Agent** (`wechat-relay-agent.ts`):
 *    - id: `wechat-relay`，名称「灵栖代聊」
 *    - 首次启动播种到用户 agents.json（`seedIfAbsent`）
 *    - systemPrompt 含护栏分区（`relayOwnedSection`），关掉通用契约 9 个段
 *
 * 3. **渠道策略** (`channel-policy.ts`):
 *    - 四档：`ignore` / `notify` / `draft` / `auto`
 *    - peer 粒度（可按群/人配置），带冷却与熔断
 *
 * ## 禁用的实现（启动期状态门）
 *
 * 盯梢循环是 `wechat-watch` cron，播种在 bridge 初始化时（`bridge.ts` 的
 * `ensureWechatWatchCronJobSeeded`）。那里传 `pluginEnabled: isExtensionActive('com.lumii.relay')`：
 * - 插件禁用 → **已存在的任务也被停掉**（`UPDATE ... SET enabled = 0`），
 *   只挡住新播种的话，装过这版的机器上那条 15 秒循环照转
 * - 与「MCP 没配」共用同一条暂停路径和自动恢复标记
 *
 * 未做：代聊配置迁到插件配置系统（目前散落在多处 JSON）。
 */
export const relayExtension = {
  manifest: {
    id: 'com.lumii.relay',
    name: '代聊',
    version: '0.1.0',
    description: '微信消息盯梢与自动回复（notify/draft/auto 三档）',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.relay',
    provides: ['relay'],
    apply(ctx) {
      // 播种点仍在 bridge（要它注入的 db / driveTurn / mcpManager），但**开关归插件**：
      // 启用即恢复/播种，停用即真的把那条 15 秒循环停掉。bridge 在 S7.4 才建，
      // 插件在 S1 激活——没建好就等 `agent:runtime-ready`。
      const wire = (): boolean => {
        const bridge = ctx.get(S.agentRuntime)?.get()
        if (!bridge) return false
        bridge.setRelayLoopEnabled(true)
        ctx.effect(() => bridge.setRelayLoopEnabled(false))
        return true
      }
      if (!wire()) {
        ctx.on('agent:runtime-ready', () => {
          wire()
        })
      }

      ctx.log.info('代聊插件已加载（盯梢循环随插件启停）')
    },
  }),
}
