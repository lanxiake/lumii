import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  readExtensionPrefs,
  setClientExtensionEnabled,
  setMainExtensionEnabled,
} from './extension-store'

describe('readExtensionPrefs', () => {
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
    const result = readExtensionPrefs(file)

    expect(result.disabled.size).toBe(0)
    expect(result.disabledClient.size).toBe(0)
    expect(result.warning).toBeUndefined()
  })

  it('读取正常文件', () => {
    writeFileSync(file, JSON.stringify({ version: 1, disabled: ['com.lumii.perf'] }))

    expect([...readExtensionPrefs(file).disabled]).toEqual(['com.lumii.perf'])
  })

  it('坏 JSON 按全部启用处理，并给出 warn', () => {
    writeFileSync(file, '{ this is not json')

    const result = readExtensionPrefs(file)

    expect(result.disabled.size).toBe(0)
    expect(result.warning).toMatch(/不是合法 JSON/)
  })

  it('缺 disabled 数组按全部启用处理，并给出 warn', () => {
    writeFileSync(file, JSON.stringify({ version: 1 }))

    const result = readExtensionPrefs(file)

    expect(result.disabled.size).toBe(0)
    expect(result.warning).toMatch(/缺少 disabled/)
  })

  it('忽略数组里的非字符串项，不让坏数据污染集合', () => {
    writeFileSync(file, JSON.stringify({ version: 1, disabled: ['ok.id', 42, null, { x: 1 }] }))

    expect([...readExtensionPrefs(file).disabled]).toEqual(['ok.id'])
  })

  it('旧文件没有 disabledClient 字段时按空集合处理，且不报 warn', () => {
    writeFileSync(file, JSON.stringify({ version: 1, disabled: ['com.lumii.voice'] }))

    const result = readExtensionPrefs(file)

    expect(result.disabledClient.size).toBe(0)
    expect(result.warning).toBeUndefined()
  })
})

describe('写入', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lumii-ext-store-'))
    file = path.join(dir, 'extensions.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('关掉再打开，往返一致', () => {
    setMainExtensionEnabled('com.lumii.pet', false, file)
    expect([...readExtensionPrefs(file).disabled]).toEqual(['com.lumii.pet'])

    setMainExtensionEnabled('com.lumii.pet', true, file)
    expect([...readExtensionPrefs(file).disabled]).toEqual([])
  })

  it('改客户端集合不动主进程集合', () => {
    setMainExtensionEnabled('com.lumii.pet', false, file)
    setClientExtensionEnabled('demo-card', false, file)

    const prefs = readExtensionPrefs(file)

    expect([...prefs.disabled]).toEqual(['com.lumii.pet'])
    expect([...prefs.disabledClient]).toEqual(['demo-card'])
  })

  it('重复关闭同一项不会写出重复条目', () => {
    setMainExtensionEnabled('com.lumii.pet', false, file)
    setMainExtensionEnabled('com.lumii.pet', false, file)

    expect([...readExtensionPrefs(file).disabled]).toEqual(['com.lumii.pet'])
  })

  it('写出的文件是合法 JSON 且带 version 2', () => {
    setClientExtensionEnabled('demo-card', false, file)

    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(raw.version).toBe(2)
    expect(raw.disabledClient).toEqual(['demo-card'])
  })
})
