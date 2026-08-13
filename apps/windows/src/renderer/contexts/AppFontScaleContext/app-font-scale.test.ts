/**
 * 全局字号档位：四档级差、默认中、循环切换与旧值兼容
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyFontLevel,
  CHAT_FONT_PX,
  DEFAULT_FONT_SCALE_LEVEL,
  LEVEL_FACTOR,
  LEVEL_LABEL,
  LEVELS,
  loadLevel,
  nextLevel,
  parseLevel,
} from './app-font-scale'

describe('app-font-scale', () => {
  it('提供小/中/大/超大四档，默认中', () => {
    expect(LEVELS).toEqual(['small', 'medium', 'large', 'xlarge'])
    expect(DEFAULT_FONT_SCALE_LEVEL).toBe('medium')
    expect(LEVEL_LABEL).toEqual({
      small: '小',
      medium: '中',
      large: '大',
      xlarge: '超大',
    })
  })

  it('档位倍率以中为 1，级差明显大于旧三档 12.5%', () => {
    expect(LEVEL_FACTOR).toEqual({
      small: 0.85,
      medium: 1,
      large: 1.25,
      xlarge: 1.5,
    })
  })

  it('对话消息字号随档位拉开，中档保持 15px', () => {
    expect(CHAT_FONT_PX).toEqual({
      small: 13,
      medium: 15,
      large: 19,
      xlarge: 23,
    })
  })

  it('循环切换：小 → 中 → 大 → 超大 → 小', () => {
    expect(nextLevel('small')).toBe('medium')
    expect(nextLevel('medium')).toBe('large')
    expect(nextLevel('large')).toBe('xlarge')
    expect(nextLevel('xlarge')).toBe('small')
  })

  it('解析档位字符串，兼容旧数值倍率', () => {
    expect(parseLevel('small')).toBe('small')
    expect(parseLevel('medium')).toBe('medium')
    expect(parseLevel('large')).toBe('large')
    expect(parseLevel('xlarge')).toBe('xlarge')
    expect(parseLevel('0.875')).toBe('small')
    expect(parseLevel('1')).toBe('medium')
    expect(parseLevel('1.125')).toBe('large')
    expect(parseLevel('1.45')).toBe('xlarge')
    expect(parseLevel(null)).toBeNull()
    expect(parseLevel('nope')).toBeNull()
  })

  it('无本地存储时 loadLevel 返回中', () => {
    localStorage.clear()
    expect(loadLevel()).toBe('medium')
  })

  it('applyFontLevel 把倍率与对话字号写到根节点', () => {
    applyFontLevel('xlarge')
    const root = document.documentElement
    expect(root.style.getPropertyValue('--app-font-scale')).toBe('1.5')
    expect(root.dataset.fontScale).toBe('xlarge')
    expect(root.style.getPropertyValue('--chat-font-size')).toBe('23px')
    expect(root.style.getPropertyValue('--font-size-sm')).toBe('21px')
  })
})

afterEach(() => {
  document.documentElement.removeAttribute('style')
  delete document.documentElement.dataset.fontScale
})
