import { PluginHost } from '@mtbot/plugin-core'
import { beforeEach, describe, expect, it } from 'vitest'

import type { MainEvents } from '../../../main/kernel/events'
import { S } from '../../../main/kernel/services'
import { dashboardFeedExtension } from './index'

/**
 * 判据：服务随作用域来去。
 *
 * 插件停用后，cron 归档、新闻命令、控制面 API 都拿不到服务——
 * 它们按既定降级（跳过/报错）走，而不是继续读写插件自己的存储。
 */
describe('dashboard-feed 插件', () => {
  let host: PluginHost<MainEvents>

  beforeEach(() => {
    host = new PluginHost<MainEvents>({ ipcRegistry: { register: () => {}, unregister: () => {} } })
    host.register(dashboardFeedExtension.definition)
  })

  it('启用后提供 S.dashboardFeed（读接口齐全）', async () => {
    expect(await host.activate('com.lumii.dashboard-feed')).toBeFalsy()

    const service = host.container.get(S.dashboardFeed)
    expect(service).toBeDefined()
    expect(typeof service!.readVersion).toBe('function')
    expect(typeof service!.readSnapshot).toBe('function')
    expect(typeof service!.prependActiveItem).toBe('function')
    expect(typeof service!.installTools).toBe('function')
  })

  it('停用后服务消失（核心的三条消费路径自动跳过）', async () => {
    await host.activate('com.lumii.dashboard-feed')
    await host.stop('com.lumii.dashboard-feed')
    expect(host.container.get(S.dashboardFeed)).toBeUndefined()
  })
})
