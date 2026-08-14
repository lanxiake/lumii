import { describe, expect, it } from 'vitest'
import { devicePixelsToDip } from './coords'

describe('devicePixelsToDip', () => {
  it('scaleFactor 为 1 时原样返回', () => {
    expect(devicePixelsToDip(100, 1)).toBe(100)
  })

  it('按 scaleFactor 换算 DIP', () => {
    expect(devicePixelsToDip(200, 2)).toBe(100)
    expect(devicePixelsToDip(150, 1.5)).toBe(100)
  })

  it('scaleFactor 非法时回退为原值', () => {
    expect(devicePixelsToDip(80, 0)).toBe(80)
    expect(devicePixelsToDip(80, -1)).toBe(80)
  })
})
