import { definePlugin } from '@mtbot/plugin-core'

import type { ChannelContinuityService } from '../../../main/channel/continuity-accessor'
import type { MainEvents } from '../../../main/kernel/events'
import { S } from '../../../main/kernel/services'
import {
  getChannelFeatures,
  setChannelFeatures,
} from './store'
import { resolveContinuityForChannel, resetContinuityInstance } from './continuity'
import type { ChannelFeatureSettings } from '../../../shared/channel-features'

/**
 * 跨渠道会话接续（实验功能）。
 *
 * 插件提供三样东西：
 * 1. 服务 `S.channelContinuity`：四个渠道 adapter、斜杠命令 `/clear` 都从这里取状态机；
 * 2. IPC `channel:getFeatures` / `channel:setFeatures`：设置页开关读写；
 * 3. 开关存储 `channel-features.json`（随插件目录走，停用后核心读不到 ⇒ 按关闭处理）。
 *
 * 停用即：服务消失 → adapter 拿不到状态机 → 不再询问接续；IPC 随作用域摘掉 →
 * 设置页开关随之消失（渲染层 `usePluginEnabled` 过滤）。
 */
export const channelContinuityExtension = {
  manifest: {
    id: 'com.lumii.channel-continuity',
    name: '跨渠道会话接续',
    version: '0.1.0',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.channel-continuity',
    apply(ctx) {
      ctx.registerIpc?.('channel:getFeatures', () => getChannelFeatures())
      ctx.registerIpc?.('channel:setFeatures', (_event, patch) =>
        setChannelFeatures((patch ?? {}) as Partial<ChannelFeatureSettings>),
      )

      ctx.provide(S.channelContinuity, {
        getFeatures: getChannelFeatures,
        setFeatures: setChannelFeatures,
        forChannel: (bridge) =>
          resolveContinuityForChannel({
            enabled: getChannelFeatures().crossChannelContinuityEnabled,
            bridge,
          }),
      } satisfies ChannelContinuityService)

      ctx.effect(() => {
        resetContinuityInstance()
      })
    },
  }),
}
