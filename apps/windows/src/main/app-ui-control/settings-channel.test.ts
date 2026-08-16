import { describe, expect, it } from 'vitest'
import {
  PROTECTED_SETTINGS_PATHS,
  assertWritablePatch,
  buildPatchScript,
  buildReadScript,
  expandPathValue,
} from './settings-channel'

describe('settings-channel', () => {
  it('expandPathValue 展开点号路径', () => {
    expect(expandPathValue('theme.mode', 'light')).toEqual({ theme: { mode: 'light' } })
  })

  it('受保护字段拒绝', () => {
    expect(assertWritablePatch({ privacy: { allowAgentAppUiControl: false } })).toEqual({
      ok: false,
      error: 'field_protected',
    })
    expect(PROTECTED_SETTINGS_PATHS).toContain('privacy.allowAgentAppUiControl')
  })

  it('不触及受保护字段的 patch 通过', () => {
    expect(assertWritablePatch({ theme: { mode: 'dark' } })).toEqual({ ok: true })
  })

  it('buildPatchScript 含 setItem 与 mtbot-settings-update', () => {
    const script = buildPatchScript({ theme: { mode: 'dark' } })
    expect(script).toContain("KEY = 'mtbot-assistant-settings'")
    expect(script).toContain('localStorage.setItem(KEY')
    expect(script).toContain('mtbot-settings-update')
    expect(script).toContain('"mode":"dark"')
  })

  it('含引号与中文的 patch 仍是合法嵌入', () => {
    const script = buildPatchScript({ language: 'zh-"CN"' })
    expect(() => new Function(script)).not.toThrow()
  })

  it('buildReadScript 无 setItem；省略 key 返回整份', () => {
    const all = buildReadScript()
    expect(all).not.toContain('setItem')
    expect(buildReadScript('privacy.saveChatHistory')).toContain('privacy.saveChatHistory')
  })
})
