// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BUILTIN_CARD_TYPES,
  CardRegistryError,
  getCardRenderer,
  listPluginCardTypes,
  registerCard,
  __resetCardRegistryForTest,
} from './card-registry'

const Fake = vi.fn() as never

describe('card-registry', () => {
  beforeEach(() => {
    __resetCardRegistryForTest()
  })

  it('注册后能取回，注销后取不到', () => {
    const off = registerCard('acme.weather', Fake)

    expect(getCardRenderer('acme.weather')).toBe(Fake)
    off()
    expect(getCardRenderer('acme.weather')).toBeUndefined()
  })

  it('内建类型不允许被插件覆盖', () => {
    for (const type of BUILTIN_CARD_TYPES) {
      expect(() => registerCard(type, Fake)).toThrow(CardRegistryError)
    }
    expect(BUILTIN_CARD_TYPES).toContain('Text')
    expect(BUILTIN_CARD_TYPES).toContain('DataTable')
  })

  it('重复注册同一类型抛错（而不是后者静默生效）', () => {
    registerCard('acme.dup', Fake)

    expect(() => registerCard('acme.dup', Fake)).toThrow(/已被注册/)
  })

  it('旧的注销函数不会误删新注册的实现', () => {
    const first = vi.fn() as never
    const second = vi.fn() as never
    const offFirst = registerCard('acme.reload', first)
    offFirst()
    registerCard('acme.reload', second)

    offFirst() // 再调一次旧注销：不应影响新实现
    expect(getCardRenderer('acme.reload')).toBe(second)
  })

  it('listPluginCardTypes 只列插件类型且有序', () => {
    registerCard('acme.zzz', Fake)
    registerCard('acme.aaa', Fake)

    expect(listPluginCardTypes()).toEqual(['acme.aaa', 'acme.zzz'])
  })
})
