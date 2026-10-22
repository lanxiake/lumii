import { PluginHost } from '@mtbot/plugin-core'
import { beforeEach, describe, expect, it } from 'vitest'

import type { MainEvents } from '../../../main/kernel/events'
import { S } from '../../../main/kernel/services'
import { autonomousExtension } from './index'

/**
 * 判据：服务与 IPC 都随作用域来去。
 *
 * bridge 拿不到 `S.autonomous` 时，心跳、Prompt 变体、反馈信号、cron 播种全部
 * 变成 no-op —— 这就是「禁用即功能消失」的全部实现。
 */
describe('autonomous 插件', () => {
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
    host.register(autonomousExtension.definition)
  })

  it('启用后提供 S.autonomous，并挂上 autonomous:* 通道', async () => {
    expect(await host.activate('com.lumii.autonomous')).toBeFalsy()

    expect(host.container.get(S.autonomous)).toBeDefined()
    expect(handlers.has('autonomous:getStatus')).toBe(true)
    expect(handlers.has('autonomous:setEnabled')).toBe(true)
  })

  it('停用后服务与全部通道一起消失（bridge 的调用变成 no-op）', async () => {
    await host.activate('com.lumii.autonomous')
    const count = handlers.size
    expect(count).toBeGreaterThan(10)

    await host.stop('com.lumii.autonomous')

    expect(host.container.get(S.autonomous)).toBeUndefined()
    expect(handlers.size).toBe(0)
  })
})
