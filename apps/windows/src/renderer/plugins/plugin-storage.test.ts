// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import { createPluginStorage } from './plugin-storage'

describe('createPluginStorage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('JSON 往返，读不到时给 fallback', () => {
    const storage = createPluginStorage('a')
    storage.set('n', 42)
    storage.set('obj', { x: [1, 2] })

    expect(storage.get('n')).toBe(42)
    expect(storage.get('obj')).toEqual({ x: [1, 2] })
    expect(storage.get('missing', 'fallback')).toBe('fallback')
  })

  it('两个插件互不串 key', () => {
    const a = createPluginStorage('a')
    const b = createPluginStorage('b')
    a.set('settings', { theme: 'dark' })
    b.set('settings', { theme: 'light' })

    expect(a.get('settings')).toEqual({ theme: 'dark' })
    expect(b.get('settings')).toEqual({ theme: 'light' })
    expect(a.keys()).toEqual(['settings'])

    a.clear()
    expect(a.keys()).toEqual([])
    expect(b.get('settings')).toEqual({ theme: 'light' })
  })

  it('坏 JSON 不抛错，返回 fallback', () => {
    const storage = createPluginStorage('c')
    localStorage.setItem('lumii.plugin.c.bad', '{not json')

    expect(storage.get('bad', 'fallback')).toBe('fallback')
  })
})
