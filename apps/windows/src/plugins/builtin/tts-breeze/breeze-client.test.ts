import { describe, it, expect } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { isBreezeConfigured, s16leToFloat32 } from './breeze-client'

describe('Breeze 就绪判定', () => {
  it('填了已运行的服务地址即视为可配置（只连不管）', () => {
    expect(isBreezeConfigured({ baseUrl: 'http://127.0.0.1:7860' })).toBe(true)
  })

  it('什么都没填 → 不可用（下拉置灰，而不是选中后才报错）', () => {
    expect(isBreezeConfigured({})).toBe(false)
  })

  it('仓库路径不是 Breeze 仓库 → 不可用', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-not-repo-'))
    try {
      expect(isBreezeConfigured({ repoPath: dir })).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('仓库对了但没有 python → 不可用', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breeze-no-py-'))
    try {
      fs.mkdirSync(path.join(dir, 'breeze_infer'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'breeze_infer', 'api.py'), '')
      expect(isBreezeConfigured({ repoPath: dir })).toBe(false)
      // 显式给了解释器就算就绪
      expect(isBreezeConfigured({ repoPath: dir, python: 'C:/py/python.exe' })).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Breeze PCM 转换', () => {
  it('s16le 小端 → [-1, 1]', () => {
    // 0, 32767, -32768, 16384
    const bytes = new Uint8Array([
      0x00, 0x00,
      0xff, 0x7f,
      0x00, 0x80,
      0x00, 0x40,
    ])
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
