import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../kernel/events'

/**
 * 事件日志插件：验证插件生命周期事件接线是否正常工作。
 *
 * 订阅所有已接线的事件并打印日志，用于验证：
 * 1. 事件能否从主进程传递到插件
 * 2. 事件载荷是否完整
 * 3. 依赖注入链路是否畅通
 */
export const eventLoggerExtension = {
  manifest: {
    id: 'com.lumii.event-logger',
    name: '事件日志',
    version: '0.1.0',
    description: '记录插件生命周期事件，用于验证事件系统',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.event-logger',
    apply(ctx) {
      ctx.log.info('事件日志插件已激活')

      // agent:turn-start
      ctx.on('agent:turn-start', (payload) => {
        ctx.log.info('📥 agent:turn-start', {
          instanceId: payload.instanceId,
          conversationId: payload.conversationId,
          at: new Date(payload.at).toISOString(),
        })
      })

      // agent:turn-end
      ctx.on('agent:turn-end', (payload) => {
        ctx.log.info('📤 agent:turn-end', {
          instanceId: payload.instanceId,
          conversationId: payload.conversationId,
          success: payload.success,
          at: new Date(payload.at).toISOString(),
        })
      })

      // llm:after-response
      ctx.on('llm:after-response', (payload) => {
        ctx.log.info('🤖 llm:after-response', {
          instanceId: payload.instanceId,
          conversationId: payload.conversationId,
          success: payload.success,
          modelId: payload.modelId,
          inputTokens: payload.usage?.inputTokens,
          outputTokens: payload.usage?.outputTokens,
          at: new Date(payload.at).toISOString(),
        })
      })

      // workspace:changed
      ctx.on('workspace:changed', (payload) => {
        ctx.log.info('📁 workspace:changed', {
          oldDir: payload.oldDir,
          newDir: payload.newDir,
          at: new Date(payload.at).toISOString(),
        })
      })

      ctx.log.info('已订阅 4 个生命周期事件')
    },
  }),
}
