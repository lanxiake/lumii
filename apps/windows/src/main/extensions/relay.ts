import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../kernel/events'
import { S } from '../kernel/services'
import { ensureWechatWatchCronJobSeeded } from '../agent-runtime/wechat-watch-tick'

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
 * ## P1 vs P2
 *
 * - P1: 包装成插件，支持禁用/启用，核心逻辑不动（cron 任务在 bridge 初始化时播种，见 `bridge.ts`）
 * - P2: 代聊配置迁移到插件配置系统（目前散落在多处 JSON）
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
      // 代聊的实际激活在 bridge 初始化时完成（见 `bridge.ts` S7 阶段调用
      // `ensureWechatWatchCronJobSeeded`）。本插件作为"声明式开关"存在：
      // - 启用时：cron 任务正常注册并运行
      // - 禁用时：P2 改造后在此处禁用 cron（P1 阶段插件禁用 = 代码不加载，
      //   但 bridge 照旧初始化，cron 照旧播种——所以 P1 禁用插件**不影响**代聊运行）
      //
      // 为什么不在这里调 `ensureWechatWatchCronJobSeeded`：
      // 1. bridge 在 S7 初始化，app:ready 在 S8，时序已定
      // 2. 盯梢需要 bridge.driveTurn / db / mcpManager，都在 bridge 构造时注入
      // 3. 移动播种点会破坏现有初始化顺序，风险 > 收益
      //
      // P1 目标：包装 + 文档完善，不改行为；P2 才做真正的热插拔（禁用 = 停 cron）。

      ctx.log.info('代聊插件已加载（cron 任务由 bridge 初始化时播种）')

      // P2: 禁用时清理 cron
      // ctx.effect(() => {
      //   const bridge = ctx.get(S.bridge)
      //   if (bridge?.db) {
      //     bridge.db.prepare(`UPDATE local_cron_jobs SET enabled = 0 WHERE id = ?`).run('wechat-watch')
      //     ctx.log.info('代聊插件卸载，已禁用 wechat-watch cron')
      //   }
      // })
    },
  }),
}
