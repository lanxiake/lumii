/**
 * 动作注册表测试
 *
 * 同时覆盖引用动作的可用性判定 —— 它是唯一一个 isEnabled 依赖外部状态的本地动作。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { getActionsFor } from './registry'
import { registerQuoteSink } from '../quote-bridge'

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

describe('getActionsFor', () => {
  const BAR_IDS = ['quote', 'translate', 'explain', 'copy']
  const MENU_IDS = ['quote', 'copy', 'translate', 'explain', 'summarize', 'polish']

  it('浮条只放四项，按 barOrder 排序（引用首位、复制末位）', () => {
    expect(getActionsFor('bar').map((a) => a.id)).toEqual(BAR_IDS)
  })

  it('浮条里「引用」必须排第一', () => {
    expect(getActionsFor('bar')[0]!.id).toBe('quote')
  })

  it('菜单是全量：浮条装不下的总结/润色只在这里', () => {
    const ids = getActionsFor('menu').map((a) => a.id)
    expect(ids).toEqual(MENU_IDS)
    expect(ids).toContain('summarize')
    expect(ids).toContain('polish')
  })

  it('L2 动作按 single 档位声明（渲染层据此分区）', () => {
    for (const id of ['translate', 'explain', 'summarize', 'polish']) {
      expect(getActionsFor('menu').find((a) => a.id === id)?.tier).toBe('single')
    }
  })

  it('每次调用返回新数组，调用方排序/过滤不会污染注册表', () => {
    const first = getActionsFor('bar')
    const second = getActionsFor('bar')

    expect(first).not.toBe(second)
    first.reverse()
    expect(getActionsFor('bar').map((a) => a.id)).toEqual(BAR_IDS)
  })
})

describe('引用动作的可用性', () => {
  const quoteAction = () => getActionsFor('bar').find((a) => a.id === 'quote')!

  it('没有投递目标时不可用，并给出原因', () => {
    const action = quoteAction()

    expect(action.isEnabled?.({} as never)).toBe(false)
    expect(action.disabledReason).toBeTruthy()
  })

  it('注册了投递目标后可用', () => {
    cleanups.push(registerQuoteSink(() => true))

    expect(quoteAction().isEnabled?.({} as never)).toBe(true)
  })

  it('复制动作任何时候都可用（没有 isEnabled 即恒可用）', () => {
    const copy = getActionsFor('bar').find((a) => a.id === 'copy')!

    expect(copy.isEnabled).toBeUndefined()
  })
})
