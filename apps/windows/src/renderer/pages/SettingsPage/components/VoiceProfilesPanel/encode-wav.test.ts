/**
 * PCM→WAV 与克隆朗读常量单测
 */
import { describe, expect, it } from 'vitest'
import {
  CLONE_REF_PROMPT_ZH,
  MIN_CLONE_RECORD_MS,
  resolveCloneRefText,
} from './clone-ref-prompt'
import { arrayBufferToBase64, encodePcmToWav } from './encode-wav'

describe('encodePcmToWav', () => {
  it('写出合法 RIFF/WAVE 头且数据长度正确', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1])
    const buf = encodePcmToWav(samples, 48000)
    const view = new DataView(buf)
    expect(
      String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)),
    ).toBe('RIFF')
    expect(
      String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11)),
    ).toBe('WAVE')
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(48000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(buf.byteLength).toBe(44 + samples.length * 2)
  })

  it('arrayBufferToBase64 可往返还原长度', () => {
    const samples = new Float32Array([0.1, -0.1])
    const buf = encodePcmToWav(samples, 16000)
    const b64 = arrayBufferToBase64(buf)
    expect(atob(b64).length).toBe(buf.byteLength)
  })
})

describe('clone-ref-prompt', () => {
  it('导出非空中文文案与 3 秒阈值', () => {
    expect(CLONE_REF_PROMPT_ZH.length).toBeGreaterThan(10)
    expect(MIN_CLONE_RECORD_MS).toBe(3000)
  })

  it('录制来源强制使用固定文案', () => {
    expect(resolveCloneRefText('record', '任意手填')).toBe(CLONE_REF_PROMPT_ZH)
    expect(resolveCloneRefText('file', '  手填文本  ')).toBe('手填文本')
  })
})
