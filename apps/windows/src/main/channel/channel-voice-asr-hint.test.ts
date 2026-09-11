/**
 * 渠道语音 ASR 失败提示：按模型是否已下载分流文案。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import {
  CHANNEL_VOICE_ASR_EMPTY_HINT,
  CHANNEL_VOICE_ASR_MODEL_MISSING_HINT,
  getChannelVoiceAsrFailedHint,
  isChannelVoiceAsrFailed,
  isWeixinSilkAsrFailed,
  resolveChannelVoiceAsrHint,
  setChannelAsrReadyChecker,
} from './channel-voice-asr-hint.js'

describe('resolveChannelVoiceAsrHint', () => {
  it('模型未就绪时引导下载 Paraformer', () => {
    expect(resolveChannelVoiceAsrHint(false)).toBe(CHANNEL_VOICE_ASR_MODEL_MISSING_HINT)
    expect(CHANNEL_VOICE_ASR_MODEL_MISSING_HINT).toContain('Paraformer 中文离线 ASR (Small)')
    expect(CHANNEL_VOICE_ASR_MODEL_MISSING_HINT).toContain('设置 → 语音设置')
  })

  it('模型已就绪但识别为空时提示重说或改用文字', () => {
    expect(resolveChannelVoiceAsrHint(true)).toBe(CHANNEL_VOICE_ASR_EMPTY_HINT)
  })
})

describe('getChannelVoiceAsrFailedHint + checker', () => {
  beforeEach(() => {
    setChannelAsrReadyChecker(null)
  })

  it('未注入 checker 时按未就绪处理', () => {
    expect(getChannelVoiceAsrFailedHint()).toBe(CHANNEL_VOICE_ASR_MODEL_MISSING_HINT)
  })

  it('注入 checker 后按返回值分流', () => {
    setChannelAsrReadyChecker(() => true)
    expect(getChannelVoiceAsrFailedHint()).toBe(CHANNEL_VOICE_ASR_EMPTY_HINT)
    setChannelAsrReadyChecker(() => false)
    expect(getChannelVoiceAsrFailedHint()).toBe(CHANNEL_VOICE_ASR_MODEL_MISSING_HINT)
  })
})

describe('isChannelVoiceAsrFailed', () => {
  it('audio/voice 无转录视为失败', () => {
    expect(isChannelVoiceAsrFailed('audio', undefined)).toBe(true)
    expect(isChannelVoiceAsrFailed('audio', '')).toBe(true)
    expect(isChannelVoiceAsrFailed('voice', '[语音消息]')).toBe(true)
    expect(isChannelVoiceAsrFailed('voice', '说明\n[语音消息]')).toBe(true)
  })

  it('有语音转录或成功原文不算失败', () => {
    expect(isChannelVoiceAsrFailed('audio', '你好')).toBe(false)
    expect(isChannelVoiceAsrFailed('voice', '[语音转录: 你好]')).toBe(false)
    expect(isChannelVoiceAsrFailed('voice', '说明\n[语音转录: 你好]')).toBe(false)
  })

  it('非语音类型不算 ASR 失败', () => {
    expect(isChannelVoiceAsrFailed('text', '')).toBe(false)
    expect(isChannelVoiceAsrFailed('image', '[语音消息]')).toBe(false)
    expect(isChannelVoiceAsrFailed('file', undefined)).toBe(false)
  })
})

describe('isWeixinSilkAsrFailed', () => {
  it('仅有 silk 且无转录时为失败', () => {
    expect(
      isWeixinSilkAsrFailed({
        mediaLines: ['[media attached: uploads/a.silk]'],
        transcript: '',
        hasUserText: false,
      }),
    ).toBe(true)
  })

  it('有转录或有用户文字时不算失败', () => {
    expect(
      isWeixinSilkAsrFailed({
        mediaLines: ['[media attached: uploads/a.silk]'],
        transcript: '你好',
        hasUserText: true,
      }),
    ).toBe(false)
    expect(
      isWeixinSilkAsrFailed({
        mediaLines: ['[media attached: uploads/a.silk]'],
        transcript: '',
        hasUserText: true,
      }),
    ).toBe(false)
  })

  it('无 silk 不算失败', () => {
    expect(
      isWeixinSilkAsrFailed({
        mediaLines: ['[media attached: uploads/a.jpg]'],
        transcript: '',
        hasUserText: false,
      }),
    ).toBe(false)
  })
})
