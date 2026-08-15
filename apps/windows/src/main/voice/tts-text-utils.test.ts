import { describe, expect, it } from 'vitest'
import {
  analyzeScriptRatio,
  resolveQwen3TtsLanguage,
  sanitizeTtsPlainText,
} from './tts-text-utils.js'

describe('sanitizeTtsPlainText', () => {
  it('剥离 markdown 加粗，避免 ** 进合成器', () => {
    expect(sanitizeTtsPlainText('我会**认真对待**你说的话')).toBe('我会认真对待你说的话')
  })

  it('清洗后仅剩标点则返回空', () => {
    expect(sanitizeTtsPlainText('***')).toBe('')
  })
})

describe('resolveQwen3TtsLanguage', () => {
  it('显式语言原样返回', () => {
    expect(resolveQwen3TtsLanguage('English', '你好')).toBe('English')
  })

  it('Auto + 中文为主 → Chinese', () => {
    const text = '不会。我没有情绪，不会因为你说什么而生气或难过——这是实话。'
    expect(resolveQwen3TtsLanguage('Auto', text)).toBe('Chinese')
    expect(analyzeScriptRatio(text).cjk).toBeGreaterThan(10)
  })

  it('Auto + 英文为主 → English', () => {
    expect(resolveQwen3TtsLanguage('Auto', 'Hello, this is a voice preview.')).toBe('English')
  })

  it('短英文句单独会判 English，整段中文应锁 Chinese（供流水线锁定）', () => {
    expect(resolveQwen3TtsLanguage('Auto', 'Hello there.')).toBe('English')
    expect(
      resolveQwen3TtsLanguage('Auto', '今天天气不错。Hello there. 我们继续聊。'),
    ).toBe('Chinese')
  })
})
