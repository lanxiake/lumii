import { describe, expect, it, vi } from 'vitest'

import { createIpcTable } from './ipc'

describe('createIpcTable', () => {
  it('install 支持「注册器对象」与「函数」两种形态', () => {
    const table = createIpcTable()
    table.register('a:one', () => 1)
    table.register('a:two', () => 2)

    const viaObject = vi.fn()
    table.install({ handle: viaObject })
    expect(viaObject.mock.calls.map((c) => c[0])).toEqual(['a:one', 'a:two'])

    const viaFn = vi.fn()
    table.install(viaFn)
    expect(viaFn).toHaveBeenCalledTimes(2)
  })

  it('同通道重复登记以后者为准（测试里替换 handler 不抛）', () => {
    const table = createIpcTable()
    const first = vi.fn()
    const second = vi.fn()
    table.register('a:one', first)
    table.register('a:one', second)

    const handlers: Array<[string, () => unknown]> = []
    table.install((ch, fn) => handlers.push([ch, fn as () => unknown]))
    handlers[0][1]()

    expect(second).toHaveBeenCalled()
    expect(first).not.toHaveBeenCalled()
    expect(table.channels()).toEqual(['a:one'])
  })
})
