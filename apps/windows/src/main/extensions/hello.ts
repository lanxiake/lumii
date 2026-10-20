import { createServiceKey, definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../kernel/events'

/**
 * P0 示例扩展：唯一目的是证明内核在真实主进程里跑得通。
 *
 * 它同时覆盖三件事：提供并解析服务、写带 pluginId 的日志、作用域随宿主停止而回收。
 * 真正的内置扩展（perf、云同步、语音……）按同一形状写。
 */

export const HELLO_SERVICE = createServiceKey<{ greet(name: string): string }>('hello')

export const helloExtension = {
  manifest: {
    id: 'com.lumii.hello',
    name: '示例扩展',
    version: '0.1.0',
    description: '验证扩展内核可用性的最小示例',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
    main: './hello.js',
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.hello',
    provides: ['hello'],
    apply(ctx) {
      ctx.provide(HELLO_SERVICE, {
        greet: (name: string) => `你好，${name}`,
      })
      ctx.log.info('已激活')
    },
  }),
}
