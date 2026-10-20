import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readDisabledExtensionIds } from './extension-store'

describe('readDisabledExtensionIds', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lumii-ext-store-'))
    file = path.join(dir, 'extensions.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('文件不存在时视为全部启用，且不报 warn', () => {
    const result = readDisabledExtensionIds(file)

    expect(result.disabled.size).toBe(0)
    expect(result.warning).toBeUndefined()
  })

  it('读取正常文件', () => {
    writeFileSync(file, JSON.stringify({ version: 1, disabled: ['com.lumii.perf'] }))

    expect([...readDisabledExtensionIds(file).disabled]).toEqual(['com.lumii.perf'])
  })

  it('坏 JSON 按全部启用处理，并给出 warn', () => {
    writeFileSync(file, '{ this is not json')

    const result = readDisabledExtensionIds(file)

    expect(result.disabled.size).toBe(0)
    expect(result.warning).toMatch(/不是合法 JSON/)
  })

  it('缺 disabled 数组按全部启用处理，并给出 warn', () => {
    writeFileSync(file, JSON.stringify({ version: 1 }))

    const result = readDisabledExtensionIds(file)

    expect(result.disabled.size).toBe(0)
    expect(result.warning).toMatch(/缺少 disabled/)
  })

  it('忽略数组里的非字符串项，不让坏数据污染集合', () => {
    writeFileSync(file, JSON.stringify({ version: 1, disabled: ['ok.id', 42, null, { x: 1 }] }))

    expect([...readDisabledExtensionIds(file).disabled]).toEqual(['ok.id'])
  })
})
