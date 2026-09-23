/**
 * pet-theme 的单测。
 *
 * 重点不在 DOM（那部分就两行），而在**与 `ThemeContext.loadTheme` 的取值顺序对齐**：
 * 两边不一致时宠物窗会和主窗显示成两个主题，而且**不会报错**——只能靠这里逐条钉住。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  resolvePetTheme,
  resolveSystemTheme,
  isAppliedTheme,
  readPetTheme,
  applyPetTheme,
  subscribePetTheme,
} from './pet-theme'

const SETTINGS_KEY = 'mtbot-assistant-settings'
const THEME_KEY = 'mtbot_theme'

const settingsWith = (mode: unknown): string => JSON.stringify({ theme: { mode } })

describe('resolvePetTheme（与 ThemeContext.loadTheme 同序）', () => {
  it('settings 里的 theme.mode 优先于独立 key', () => {
    expect(resolvePetTheme(settingsWith('eye-care'), 'dark', false)).toBe('eye-care')
  })

  it('settings 缺失时用独立 key', () => {
    expect(resolvePetTheme(null, 'eye-care', false)).toBe('eye-care')
  })

  it('settings 内容损坏（JSON 坏了）时不抛，退到独立 key', () => {
    expect(resolvePetTheme('{not json', 'dark', false)).toBe('dark')
  })

  it('settings 结构不对（没有 theme.mode）时退到独立 key', () => {
    expect(resolvePetTheme(JSON.stringify({ other: 1 }), 'dark', false)).toBe('dark')
  })

  it('两份都没有 → 跟随系统（不是硬编码 light）', () => {
    expect(resolvePetTheme(null, null, true)).toBe('dark')
    expect(resolvePetTheme(null, null, false)).toBe('light')
  })

  it("mode='system' → 解析成系统的亮/暗", () => {
    expect(resolvePetTheme(settingsWith('system'), null, true)).toBe('dark')
    expect(resolvePetTheme(settingsWith('system'), null, false)).toBe('light')
  })

  it('非法值（拼错的主题名）当作没有，继续往下找', () => {
    expect(resolvePetTheme(settingsWith('Light'), 'dark', false)).toBe('dark')
    expect(resolvePetTheme(settingsWith(42), null, false)).toBe('light')
  })

  it('settings 里是 system 但独立 key 是 dark —— settings 赢（同 loadTheme）', () => {
    expect(resolvePetTheme(settingsWith('system'), 'dark', false)).toBe('light')
  })
})

describe('resolveSystemTheme / isAppliedTheme', () => {
  it('只有 dark / light 两档来自系统', () => {
    expect(resolveSystemTheme(true)).toBe('dark')
    expect(resolveSystemTheme(false)).toBe('light')
  })

  it('isAppliedTheme 不把 system 当已解析主题', () => {
    expect(isAppliedTheme('system')).toBe(false)
    expect(isAppliedTheme('eye-care')).toBe(true)
    expect(isAppliedTheme(null)).toBe(false)
  })
})

describe('readPetTheme / applyPetTheme（真 localStorage + 真 DOM）', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('从 localStorage 读出主窗写的主题', () => {
    localStorage.setItem(SETTINGS_KEY, settingsWith('eye-care'))
    expect(readPetTheme()).toBe('eye-care')
  })

  it('applyPetTheme 写 documentElement 的 data-theme（与主窗同一位置）', () => {
    applyPetTheme('eye-care')
    expect(document.documentElement.getAttribute('data-theme')).toBe('eye-care')
    document.documentElement.removeAttribute('data-theme')
  })
})

describe('subscribePetTheme', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('storage 事件带来新主题时回调一次', () => {
    localStorage.setItem(THEME_KEY, 'dark')
    const seen: string[] = []
    const off = subscribePetTheme((t) => seen.push(t))

    localStorage.setItem(THEME_KEY, 'light')
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_KEY }))
    expect(seen).toEqual(['light'])

    off()
  })

  it('主题没变时不去重失败（settings 被频繁写，不能每次都 apply）', () => {
    localStorage.setItem(THEME_KEY, 'dark')
    const onChange = vi.fn()
    const off = subscribePetTheme(onChange)

    // 只改别的设置 —— 主题值不变
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ theme: { mode: 'dark' }, other: 1 }))
    window.dispatchEvent(new StorageEvent('storage', { key: SETTINGS_KEY }))
    window.dispatchEvent(new StorageEvent('storage', { key: SETTINGS_KEY }))
    expect(onChange).not.toHaveBeenCalled()

    off()
  })

  it('取消订阅后不再回调', () => {
    localStorage.setItem(THEME_KEY, 'dark')
    const onChange = vi.fn()
    const off = subscribePetTheme(onChange)
    off()

    localStorage.setItem(THEME_KEY, 'light')
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_KEY }))
    expect(onChange).not.toHaveBeenCalled()
  })
})
