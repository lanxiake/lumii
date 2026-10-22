import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'

import { createChannelHub } from './channel-hub-bootstrap'

/**
 * 渠道是可禁用插件：被禁用时登录服务根本不建，Hub 拿到的就是 undefined。
 * 这里钉的是「缺省渠道不会把装配搞坏」——不能拿 null 服务去构造 Provider。
 */
describe('createChannelHub 缺省渠道', () => {
  const dataRoot = path.join(os.tmpdir(), 'test-channel-hub-bootstrap')

  it('飞书/企微/QQ 都没启用：只装配可用的那部分，不抛错', () => {
    const hub = createChannelHub({ dataRoot })
    expect(hub.wecomProvider).toBeNull()
    expect(hub.qbotProvider).toBeNull()
    // 没有 Provider 也不能在恢复快照时炸
    expect(() => hub.restorePeerSnapshots()).not.toThrow()
  })

  it('往未装配的渠道发送：稳定的硬失败，不是 silent success', async () => {
    const hub = createChannelHub({ dataRoot })
    const res = await hub.router.send({ channel: 'feishu', to: 'u1', text: '早' })
    expect(res.ok).toBe(false)
    expect(res.errorCode).toBe('CHANNEL_NOT_CONNECTED')
  })
})
