import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../../../main/kernel/events'
import { S } from '../../../main/kernel/services'
import { startPcwechat } from '../../../main/channel/channel-runtime'

/**
 * 本机微信渠道扩展（设置 › 渠道 › 本机微信）。
 *
 * ## 它管什么
 *
 * - 出站 Provider：Agent 的 `channel_send` 走它，把消息发给用户微信里的好友/群；
 * - 渠道卡片：回复名单与策略、环境自检、**MCP 是否可用**的提示。
 *
 * ## 它不管什么
 *
 * - **MCP 二进制与配置**（`wechat-chat-mcp` / `mcp-servers.json`）：2026-10-25 定案
 *   **MCP 与插件分开**——用户自己装、自己在「设置 › MCP 服务」里配，客户端只检测。
 *   所以这里**没有 `requires.assets`**：插件不依赖某个"资产"，它依赖的是一个用户配好的
 *   MCP Server（缺了就降级显示「未就绪」并给出跳转，不挡插件激活）。
 * - **盯梢与自动回复**是另一个插件 `com.lumii.relay`：关掉那个只是不回消息，
 *   关掉本插件才会让 `channel_send` 报 `CHANNEL_NOT_CONNECTED`。
 *
 * ## 禁用的实现
 *
 * Provider 在 `apply` 里注册、在作用域销毁时摘掉；没有登录服务需要拆。
 * 运行期启停即时生效（`hot: true`）。
 */
export const pcwechatExtension = {
  manifest: {
    id: 'com.lumii.pcwechat',
    name: '本机微信',
    version: '0.1.0',
    description:
      '以你本人身份使用这台电脑上登录的微信：按名单代回、主动发出站消息（需自行配置本机微信 MCP）',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.pcwechat',
    provides: ['pcwechat'],
    apply(ctx) {
      // Hub 在插件启动前就已建好；Agent Runtime 到 S7.4 才建，所以 bridge 现取。
      const wire = (): boolean => {
        const hub = ctx.get(S.channelHub)?.get()
        if (!hub) return false
        ctx.effect(startPcwechat(hub, () => ctx.get(S.agentRuntime)?.get() ?? null))
        return true
      }
      if (!wire()) {
        ctx.on('agent:runtime-ready', () => {
          wire()
        })
      }
      ctx.log.info('本机微信渠道已加载（出站 Provider 随插件启停）')
    },
  }),
}
