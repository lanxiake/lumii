import { describe, it, expect } from 'vitest'
import { s16leToFloat32 } from './breeze-client'

describe('Breeze PCM 转换', () => {
  it('s16le 小端 → [-1, 1]', () => {
    // 0, 32767, -32768, 16384
    const bytes = new Uint8Array([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80, 0x00, 0x40])
    const out = s16leToFloat32(bytes)
    expect(out).toHaveLength(4)
    expect(out[0]).toBe(0)
    expect(out[1]).toBeCloseTo(32767 / 32768, 5)
    expect(out[2]).toBe(-1)
    expect(out[3]).toBeCloseTo(0.5, 5)
  })

  it('奇数长度只取完整的采样，不越界', () => {
    // 3 字节 = 1 个完整 s16 + 1 个残字节
    const out = s16leToFloat32(new Uint8Array([0x00, 0x40, 0x7f]))
    expect(out).toHaveLength(1)
    expect(out[0]).toBeCloseTo(0.5, 5)
  })

  it('带 byteOffset 的视图也按自身范围读取', () => {
    const buf = new Uint8Array([0xff, 0xff, 0x00, 0x40, 0xff])
    const view = buf.subarray(2, 4)
    expect(s16leToFloat32(view)[0]).toBeCloseTo(0.5, 5)
  })
})
