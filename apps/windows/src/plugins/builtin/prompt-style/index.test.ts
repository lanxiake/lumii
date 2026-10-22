import { PluginHost } from '@mtbot/plugin-core'
import { beforeEach, describe, expect, it } from 'vitest'

import { S } from '../../../main/kernel/services'
import type { MainEvents } from '../../../main/kernel/events'
import { promptStyleExtension } from './index'

/**
 * 判据是**服务随作用域来去**：这正是「禁用即回落默认档」的实现方式。
 * IPC 的注册/摘除由 plugin-core 的作用域负责，这里只验证它接到了容器上。
 */
describe('prompt-style 插件', () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  let host: PluginHost<MainEvents>

  beforeEach(() => {
    handlers.clear()
    host = new PluginHost<MainEvents>({
      ipcRegistry: {
        register: (channel, handler) => void handlers.set(channel, handler),
        unregister: (channel) => void handlers.delete(channel),
      },
    })
    host.register(promptStyleExtension.definition)
  })

  it('启用后提供 S.promptStyle；未收到过 IPC 时回落默认档', async () => {
    expect(await host.activate('com.lumii.prompt-style')).toBeFalsy()

    const service = host.container.get(S.promptStyle)
    expect(service).toBeDefined()
    // 没有 mainWindow 服务 → 读不到渲染层 → 默认档
    expect(await service!.get()).toEqual({ style: 'terse' })
  })

  it('IPC 写入的档位被服务读到', async () => {
    await host.activate('com.lumii.prompt-style')
    const handler = handlers.get('settings:updatePromptStyle')
    expect(handler).toBeDefined()

    handler!({}, { style: 'minimal' })

    expect(await host.container.get(S.promptStyle)!.get()).toEqual({ style: 'minimal' })
  })

  it('非法载荷归一化为默认档，不写坏缓存', async () => {
    await host.activate('com.lumii.prompt-style')
    handlers.get('settings:updatePromptStyle')!({}, { style: 'whatever' })
    expect(await host.container.get(S.promptStyle)!.get()).toEqual({ style: 'terse' })
  })

  it('停用后服务消失、IPC 摘除、缓存清空', async () => {
    await host.activate('com.lumii.prompt-style')
    handlers.get('settings:updatePromptStyle')!({}, { style: 'detailed' })

    await host.stop('com.lumii.prompt-style')

    expect(host.container.get(S.promptStyle)).toBeUndefined()
    expect(handlers.has('settings:updatePromptStyle')).toBe(false)

    // 重新启用：旧缓存不能残留（否则禁用期间用户改了档位，启用后读到的还是旧值）
    await host.activate('com.lumii.prompt-style')
    expect(await host.container.get(S.promptStyle)!.get()).toEqual({ style: 'terse' })
  })
})
