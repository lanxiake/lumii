import { PluginHost } from '@mtbot/plugin-core'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/** 开关写盘：绝不能落到真实 userData（会把用户的 channel-features.json 改掉） */
const { tmpRoot } = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs')
  const { tmpdir } = require('node:os')
  const path = require('node:path')
  return { tmpRoot: mkdtempSync(path.join(tmpdir(), 'lumii-continuity-')) }
})

vi.mock('electron', () => ({ app: { getPath: () => tmpRoot } }))

import type { MainEvents } from '../../../main/kernel/events'
import { S } from '../../../main/kernel/services'
import { channelContinuityExtension } from './index'
import { rmSync } from 'node:fs'

/**
 * 判据是「服务随作用域来去」：adapter 拿不到服务 ⇒ 不再询问接续，
 * 这正是禁用插件的效果，不需要核心再加一道 isExtensionActive。
 */
describe('channel-continuity 插件', () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const bridge = { listRecentConversations: () => [] }
  let host: PluginHost<MainEvents>

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  beforeEach(() => {
    handlers.clear()
    host = new PluginHost<MainEvents>({
      ipcRegistry: {
        register: (channel, handler) => void handlers.set(channel, handler),
        unregister: (channel) => void handlers.delete(channel),
      },
    })
    host.register(channelContinuityExtension.definition)
  })

  it('启用后提供开关读写与状态机入口；开关关闭时 forChannel 为 undefined', async () => {
    expect(await host.activate('com.lumii.channel-continuity')).toBeFalsy()
    const service = host.container.get(S.channelContinuity)
    expect(service).toBeDefined()

    expect(service!.getFeatures().crossChannelContinuityEnabled).toBe(false)
    expect(service!.forChannel(bridge)).toBeUndefined()
  })

  it('开关打开后能拿到状态机（同一份开关同时供 IPC 与 adapter 使用）', async () => {
    await host.activate('com.lumii.channel-continuity')
    const service = host.container.get(S.channelContinuity)!

    handlers.get('channel:setFeatures')!({}, { crossChannelContinuityEnabled: true })

    expect(service.getFeatures().crossChannelContinuityEnabled).toBe(true)
    expect(service.forChannel(bridge)).toBeDefined()
  })

  it('停用后服务与 IPC 一起消失', async () => {
    await host.activate('com.lumii.channel-continuity')
    expect(handlers.has('channel:getFeatures')).toBe(true)

    await host.stop('com.lumii.channel-continuity')

    expect(host.container.get(S.channelContinuity)).toBeUndefined()
    expect(handlers.has('channel:getFeatures')).toBe(false)
    expect(handlers.has('channel:setFeatures')).toBe(false)
  })
})
