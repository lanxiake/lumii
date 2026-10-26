import { describe, expect, it } from 'vitest'
import { isMessagingChannelSessionKey, resolvePrimeEffectiveModel } from './session-model-prime.js'

describe('isMessagingChannelSessionKey', () => {
  it('识别飞书/微信等渠道键', () => {
    expect(isMessagingChannelSessionKey('feishu:ou_abc')).toBe(true)
    expect(isMessagingChannelSessionKey('weixin:wxid_1')).toBe(true)
    expect(isMessagingChannelSessionKey('wecom:u1')).toBe(true)
    expect(isMessagingChannelSessionKey('qbot:123')).toBe(true)
  })

  it('桌面与系统会话不是 messaging channel', () => {
    expect(isMessagingChannelSessionKey('f1b5c0ab75b7262353029c2ff92d6043')).toBe(false)
    expect(isMessagingChannelSessionKey('cron:news')).toBe(false)
    expect(isMessagingChannelSessionKey('pcwechat:peer')).toBe(false)
  })
})

describe('resolvePrimeEffectiveModel', () => {
  it('渠道会话：UI 优先于 DB deepseek', () => {
    const r = resolvePrimeEffectiveModel({
      sessionKey: 'feishu:ou_60d544',
      modelRef: 'Qwen3.8-Flash-Next',
      savedPreferred: 'deepseek-v4-flash',
      liveChatModelId: 'Qwen3.8-Flash-Next',
    })
    expect(r).toEqual({ effective: 'Qwen3.8-Flash-Next', source: 'ui' })
  })

  it('渠道会话：无 UI 时用 live chat', () => {
    const r = resolvePrimeEffectiveModel({
      sessionKey: 'feishu:ou_x',
      modelRef: undefined,
      savedPreferred: 'deepseek-v4-flash',
      liveChatModelId: 'Qwen3.8-Flash-Next',
    })
    expect(r).toEqual({ effective: 'Qwen3.8-Flash-Next', source: 'live' })
  })

  it('桌面会话：DB 粘性优先于 UI', () => {
    const r = resolvePrimeEffectiveModel({
      sessionKey: 'abc123desktop',
      modelRef: 'Qwen3.8-Flash-Next',
      savedPreferred: 'deepseek-v4-flash',
      liveChatModelId: 'Qwen3.8-Flash-Next',
    })
    expect(r).toEqual({ effective: 'deepseek-v4-flash', source: 'db' })
  })
})
