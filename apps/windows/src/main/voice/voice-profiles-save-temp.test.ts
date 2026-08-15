/**
 * saveTempCloneRefAudio 单测
 */
import fs from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { saveTempCloneRefAudio } from './voice-temp-ref'

const created: string[] = []

afterEach(() => {
  for (const p of created.splice(0)) {
    try {
      fs.unlinkSync(p)
    } catch {
      /* ignore */
    }
  }
})

describe('saveTempCloneRefAudio', () => {
  it('写入临时 wav 且内容与 base64 一致', () => {
    const payload = Buffer.alloc(64, 7)
    const filePath = saveTempCloneRefAudio(payload.toString('base64'), 'wav')
    created.push(filePath)
    expect(fs.existsSync(filePath)).toBe(true)
    expect(filePath.endsWith('.wav')).toBe(true)
    expect(Buffer.compare(fs.readFileSync(filePath), payload)).toBe(0)
  })

  it('空数据抛错', () => {
    expect(() => saveTempCloneRefAudio('')).toThrow(/空/)
  })
})
