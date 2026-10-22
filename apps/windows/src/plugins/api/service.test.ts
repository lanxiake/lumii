import { describe, expect, it, vi } from 'vitest'

import { defineServiceAccessor } from './service'

type Demo = { hello(): string }

describe('defineServiceAccessor', () => {
  it('没有 resolver 时返回 null（核心按「功能关闭」处理）', () => {
    const accessor = defineServiceAccessor<Demo>('demo')
    expect(accessor.get()).toBeNull()
  })

  it('每次现取：插件停用后自动变回 null，不需要额外清理', () => {
    const accessor = defineServiceAccessor<Demo>('demo')
    let current: Demo | null = { hello: () => 'on' }
    accessor.setResolver(() => current)

    expect(accessor.get()?.hello()).toBe('on')

    current = null // 插件 stop：容器里没了
    expect(accessor.get()).toBeNull()

    accessor.setResolver(null)
    current = { hello: () => 'on' }
    expect(accessor.get()).toBeNull()
  })

  it('resolver 抛错不影响核心（返回 null 并告警）', () => {
    const accessor = defineServiceAccessor<Demo>('demo')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    accessor.setResolver(() => {
      throw new Error('container 已销毁')
    })

    expect(accessor.get()).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
