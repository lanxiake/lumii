import { describe, expect, it } from 'vitest'
import {
  APP_PANEL_MODES,
  APP_PANEL_MODE_HINTS,
  isAppPanelMode,
} from './app-panel-modes'

describe('app-panel-modes', () => {
  it('只有 doc 是合法模式', () => {
    expect(isAppPanelMode('doc')).toBe(true)
    expect(isAppPanelMode('auto')).toBe(false)
    expect(isAppPanelMode('')).toBe(false)
    expect(isAppPanelMode(null)).toBe(false)
    expect(isAppPanelMode(undefined)).toBe(false)
    expect(isAppPanelMode(42)).toBe(false)
  })

  it('hints 的键集合必须等于模式清单（加模式忘写说明会失败）', () => {
    expect(Object.keys(APP_PANEL_MODE_HINTS).sort()).toEqual([...APP_PANEL_MODES].sort())
  })

  it('每个模式都有一句非空说明', () => {
    for (const mode of APP_PANEL_MODES) {
      expect(APP_PANEL_MODE_HINTS[mode].trim().length).toBeGreaterThan(0)
    }
  })
})
