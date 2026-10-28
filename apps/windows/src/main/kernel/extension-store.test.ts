import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  readExtensionPrefs,
  setClientExtensionEnabled,
  setMainExtensionEnabled,
} from './extension-store'
import { DEFAULT_DISABLED_EXTENSIONS } from '../../plugins/registry'

/**
 * 默认关闭项（本机微信）——从插件清单派生，测试里直接用那份。
 * 判据见 `registry.ts`：`manifest.defaultEnabled === false`。
 */
const DEFAULTS = DEFAULT_DISABLED_EXTENSIONS

/** 用户显式关掉的项（默认关闭项不算——那一份由默认值决定，不是偏好） */
function userDisabled(file: string): string[] {
  return [...readExtensionPrefs(file, DEFAULTS).disabled].filter((id) => !DEFAULTS.has(id))
}

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

  it('文件不存在时没有用户禁用项，且不报 warn', () => {
    const result = readExtensionPrefs(file, DEFAULTS)

    expect(userDisabled(file)).toEqual([])
    expect(result.disabledClient.size).toBe(0)
    expect(result.warning).toBeUndefined()
  })

  it('默认关闭的扩展即使文件不存在也是关的（默认值不依赖偏好文件）', () => {
    const result = readExtensionPrefs(file, DEFAULTS)

    expect(result.disabled).toEqual(DEFAULT_DISABLED_EXTENSIONS)
  })

  it('读取正常文件', () => {
    writeFileSync(file, JSON.stringify({ version: 1, disabled: ['com.lumii.perf'] }))

    expect(userDisabled(file)).toEqual(['com.lumii.perf'])
  })

  it('坏 JSON 按没有任何用户禁用项处理，并给出 warn', () => {
    writeFileSync(file, '{ this is not json')

    const result = readExtensionPrefs(file, DEFAULTS)

    expect(userDisabled(file)).toEqual([])
    expect(result.warning).toMatch(/不是合法 JSON/)
  })

  it('缺 disabled 数组按没有用户禁用项处理，并给出 warn', () => {
    writeFileSync(file, JSON.stringify({ version: 1 }))

    const result = readExtensionPrefs(file, DEFAULTS)

    expect(userDisabled(file)).toEqual([])
    expect(result.warning).toMatch(/缺少 disabled/)
  })

  it('忽略数组里的非字符串项，不让坏数据污染集合', () => {
    writeFileSync(file, JSON.stringify({ version: 1, disabled: ['ok.id', 42, null, { x: 1 }] }))

    expect(userDisabled(file)).toEqual(['ok.id'])
  })

  it('旧文件没有 disabledClient 字段时按空集合处理，且不报 warn', () => {
    writeFileSync(file, JSON.stringify({ version: 1, disabled: ['com.lumii.voice'] }))

    const result = readExtensionPrefs(file, DEFAULTS)

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
    expect(userDisabled(file)).toEqual(['com.lumii.pet'])

    setMainExtensionEnabled('com.lumii.pet', true, file)
    expect(userDisabled(file)).toEqual([])
  })

  it('默认关闭项：显式打开后落 enabled，关掉后回到默认', () => {
    const id = 'com.lumii.pcwechat'
    expect(DEFAULT_DISABLED_EXTENSIONS.has(id)).toBe(true)
    expect(readExtensionPrefs(file, DEFAULTS).disabled.has(id)).toBe(true)

    setMainExtensionEnabled(id, true, file, DEFAULTS)
    expect(readExtensionPrefs(file, DEFAULTS).disabled.has(id)).toBe(false)

    setMainExtensionEnabled(id, false, file, DEFAULTS)
    expect(readExtensionPrefs(file, DEFAULTS).disabled.has(id)).toBe(true)
  })

  it('写回不把默认关闭项固化成 disabled（否则改默认值就再也开不起来）', () => {
    // 开一个默认关闭项 + 关一个普通项，然后只读文件原文
    setMainExtensionEnabled('com.lumii.pcwechat', true, file, DEFAULTS)
    setMainExtensionEnabled('com.lumii.pet', false, file)

    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(raw.disabled).toEqual(['com.lumii.pet'])
    expect(raw.enabled).toEqual(['com.lumii.pcwechat'])
  })

  it('改客户端集合不动主进程集合', () => {
    setMainExtensionEnabled('com.lumii.pet', false, file)
    setClientExtensionEnabled('demo-card', false, file)

    const prefs = readExtensionPrefs(file, DEFAULTS)

    expect(userDisabled(file)).toEqual(['com.lumii.pet'])
    expect([...prefs.disabledClient]).toEqual(['demo-card'])
  })

  it('重复关闭同一项不会写出重复条目', () => {
    setMainExtensionEnabled('com.lumii.pet', false, file)
    setMainExtensionEnabled('com.lumii.pet', false, file)

    expect(userDisabled(file)).toEqual(['com.lumii.pet'])
  })

  it('写出的文件是合法 JSON 且带 version 2', () => {
    setClientExtensionEnabled('demo-card', false, file)

    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(raw.version).toBe(2)
    expect(raw.disabledClient).toEqual(['demo-card'])
  })
})
