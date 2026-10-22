import { describe, expect, it, vi } from 'vitest'

import type { RendererPlugin, RendererPluginApi } from '../api/renderer'
import { syncRendererPlugins } from './sync'

const api = { registerSlot: vi.fn(), registerCard: vi.fn() } as unknown as RendererPluginApi

function makePlugin(id: string, setup = vi.fn(() => vi.fn())): RendererPlugin & { setup: typeof setup } {
  return { id, setup }
}

describe('syncRendererPlugins', () => {
  it('启用 → setup 一次；再同步不会重复 setup（重复注册槽位会抛）', () => {
    const mounted = new Map<string, () => void>()
    const a = makePlugin('com.a')
    const enabled = new Set(['com.a'])

    syncRendererPlugins([a], enabled, mounted, api)
    syncRendererPlugins([a], enabled, mounted, api)

    expect(a.setup).toHaveBeenCalledTimes(1)
    expect(mounted.has('com.a')).toBe(true)
  })

  it('禁用 → 调用清理函数并摘下；再启用重新 setup', () => {
    const mounted = new Map<string, () => void>()
    const dispose = vi.fn()
    const a = makePlugin('com.a', vi.fn(() => dispose))

    syncRendererPlugins([a], new Set(['com.a']), mounted, api)
    syncRendererPlugins([a], new Set(), mounted, api)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(mounted.size).toBe(0)

    syncRendererPlugins([a], new Set(['com.a']), mounted, api)
    expect(a.setup).toHaveBeenCalledTimes(2)
  })

  it('setup 抛错只影响自己，其他插件照常挂载', () => {
    const mounted = new Map<string, () => void>()
    const onError = vi.fn()
    const bad: RendererPlugin = {
      id: 'com.bad',
      setup() {
        throw new Error('槽位 id 冲突')
      },
    }
    const good = makePlugin('com.good')

    syncRendererPlugins([bad, good], new Set(['com.bad', 'com.good']), mounted, api, onError)

    expect(onError).toHaveBeenCalledWith('com.bad', expect.any(Error))
    expect(mounted.has('com.bad')).toBe(false)
    expect(mounted.has('com.good')).toBe(true)
  })

  it('不在清单里的启用状态不会凭空 setup', () => {
    const mounted = new Map<string, () => void>()
    syncRendererPlugins([], new Set(['com.ghost']), mounted, api)
    expect(mounted.size).toBe(0)
  })
})
