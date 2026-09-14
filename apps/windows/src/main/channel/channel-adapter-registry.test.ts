import { beforeEach, describe, expect, it } from 'vitest'
import type { IChannelAdapter } from './types'
import {
  __resetChannelAdapterRegistry,
  getChannelAdapter,
  registerChannelAdapter,
} from './channel-adapter-registry'

const fakeAdapter = (channelType: string) => ({ channelType }) as unknown as IChannelAdapter

describe('channel-adapter-registry', () => {
  beforeEach(() => {
    __resetChannelAdapterRegistry()
  })

  it('注册后可按渠道类型取回', () => {
    const weixin = fakeAdapter('weixin')
    registerChannelAdapter(weixin)

    expect(getChannelAdapter('weixin')).toBe(weixin)
    expect(getChannelAdapter('qbot')).toBeUndefined()
  })

  it('同渠道重复注册时后者覆盖（重连后重建 adapter）', () => {
    const first = fakeAdapter('feishu')
    const second = fakeAdapter('feishu')
    registerChannelAdapter(first)
    registerChannelAdapter(second)

    expect(getChannelAdapter('feishu')).toBe(second)
  })
})
