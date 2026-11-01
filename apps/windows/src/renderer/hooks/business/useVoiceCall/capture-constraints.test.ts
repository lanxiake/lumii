/**
 * 采麦约束映射（P1-4）。
 *
 * 通信用和唤醒用必须同一套约束——用户在设置里关了降噪，唤醒不该还偷偷开着。
 * 这条用例把「配置 → MediaStreamConstraints」的映射钉住，免得哪天顺手加字段
 * 只在一条路径上生效。
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_CAPTURE, micConstraints } from './capture-constraints'

describe('micConstraints', () => {
  it('默认三开，且固定单声道', () => {
    const c = micConstraints(DEFAULT_CAPTURE) as { audio: Record<string, unknown> }
    expect(c.audio).toEqual({
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    })
  })

  it('关掉哪项就传哪项 false（不能漏传成 undefined 被浏览器当默认值）', () => {
    const c = micConstraints({
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: false,
    }) as { audio: Record<string, unknown> }
    expect(c.audio.echoCancellation).toBe(false)
    expect(c.audio.autoGainControl).toBe(false)
    expect(c.audio.noiseSuppression).toBe(true)
  })
})
