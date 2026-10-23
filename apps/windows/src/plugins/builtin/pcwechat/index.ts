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
 * - 渠道卡片：回复名单与策略、环境自检、安装/升级「微信本机助手」。
 *
 * ## 它不管什么
 *
 * - **MCP 二进制**（`wechat-chat-mcp`）是运行时资产，由插件中心的安装器管：下载 exe、
 *   写 `mcp-servers.json`、卸载。本插件只声明 `requires.assets`，缺了照样激活
 *   （卡片上给安装入口），因为「没装助手」时渠道仍然可以显示"未接入"而不是整张卡消失。
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
      '以你本人身份使用这台电脑上登录的微信：按名单代回、主动发出站消息（需安装「微信本机助手」）',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
    requires: { assets: ['wechat-chat-mcp'] },
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
