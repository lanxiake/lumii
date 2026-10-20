import { createServiceKey, definePlugin } from '@mtbot/plugin-core'

/**
 * P0 示例扩展：唯一目的是证明内核在真实主进程里跑得通。
 *
 * 它同时覆盖三件事：提供并解析服务、写带 pluginId 的日志、作用域随宿主停止而回收。
 * 真正的内置扩展（云同步、语音、录屏……）按同一形状写，见
 * docs/design/工程基建/2026-10-19-P0插件内核设计.md。
 */

export const HELLO_SERVICE = createServiceKey<{ greet(name: string): string }>('hello')

export const helloExtension = definePlugin({
  id: 'com.lumii.hello',
  provides: ['hello'],
  apply(ctx) {
    ctx.provide(HELLO_SERVICE, {
      greet: (name: string) => `你好，${name}`,
    })
    ctx.log.info('已激活')
  },
})
