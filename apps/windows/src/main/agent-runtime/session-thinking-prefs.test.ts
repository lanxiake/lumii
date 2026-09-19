/**
 * 全局思考偏好：渠道会话 / 心跳 / cron 跟随对话页开关的回归防线
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _resetWindowsClientDataRootCacheForTest } from '../client-data-root'
import { BridgeSessionThinkingPrefs } from './bridge-session-thinking-prefs'
import { loadStoredThinkingPrefs, saveStoredThinkingPrefs } from './session-thinking-store'

describe('BridgeSessionThinkingPrefs 全局默认', () => {
  it('未设置过偏好的会话（渠道/心跳/cron）跟随全局默认', () => {
    const prefs = new BridgeSessionThinkingPrefs()
    expect(prefs.getThinkingPrefs('cron:agent-self:123')).toEqual({
      thinkingEnabled: true,
      reasoningEffort: 'high',
    })

    prefs.setGlobalPrefs({ thinkingEnabled: false, reasoningEffort: 'max' })

    expect(prefs.getThinkingPrefs('cron:agent-self:123')).toEqual({
      thinkingEnabled: false,
      reasoningEffort: 'max',
    })
    expect(prefs.getThinkingPrefs('weixin:user-1')).toEqual({
      thinkingEnabled: false,
      reasoningEffort: 'max',
    })
    // 空 key（无会话上下文）也跟随全局
    expect(prefs.getThinkingPrefs('')).toEqual({ thinkingEnabled: false, reasoningEffort: 'max' })
  })

  it('会话级显式设置优先于全局默认（部分字段合并）', () => {
    const prefs = new BridgeSessionThinkingPrefs()
    prefs.setGlobalPrefs({ thinkingEnabled: false, reasoningEffort: 'high' })
    prefs.setThinkingPrefs('chat:main', { thinkingEnabled: true })

    expect(prefs.getThinkingPrefs('chat:main')).toEqual({
      thinkingEnabled: true,
      reasoningEffort: 'high',
    })
    // 其它会话不受影响
    expect(prefs.getThinkingPrefs('cron:x').thinkingEnabled).toBe(false)
  })

  it('setGlobalPrefs 部分字段合并，未给的字段保持原值', () => {
    const prefs = new BridgeSessionThinkingPrefs({ thinkingEnabled: false, reasoningEffort: 'max' })
    expect(prefs.setGlobalPrefs({ reasoningEffort: 'high' })).toEqual({
      thinkingEnabled: false,
      reasoningEffort: 'high',
    })
  })

  it('构造时注入落盘值（重启后继承）', () => {
    const prefs = new BridgeSessionThinkingPrefs({ thinkingEnabled: false, reasoningEffort: 'max' })
    expect(prefs.getThinkingPrefs('cron:boot')).toEqual({
      thinkingEnabled: false,
      reasoningEffort: 'max',
    })
  })

  it('clearThinkingPrefs 后回落全局默认', () => {
    const prefs = new BridgeSessionThinkingPrefs()
    prefs.setGlobalPrefs({ thinkingEnabled: false })
    prefs.setThinkingPrefs('chat:main', { thinkingEnabled: true })
    prefs.clearThinkingPrefs('chat:main')

    expect(prefs.getThinkingPrefs('chat:main').thinkingEnabled).toBe(false)
  })
})

describe('session-thinking-store 落盘往返', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-thinking-store-'))
    process.env.LUMII_CLIENT_DATA_DIR = dir
    _resetWindowsClientDataRootCacheForTest()
  })

  afterEach(() => {
    delete process.env.LUMII_CLIENT_DATA_DIR
    _resetWindowsClientDataRootCacheForTest()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('文件不存在时返回 undefined', () => {
    expect(loadStoredThinkingPrefs()).toBeUndefined()
  })

  it('写入后可读回（含目录自建）', () => {
    saveStoredThinkingPrefs({ thinkingEnabled: false, reasoningEffort: 'max' })
    expect(loadStoredThinkingPrefs()).toEqual({ thinkingEnabled: false, reasoningEffort: 'max' })
  })

  it('文件损坏时返回 undefined，不抛错', () => {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'config', 'session-thinking.json'), '{oops', 'utf8')
    expect(loadStoredThinkingPrefs()).toBeUndefined()
  })

  it('字段缺失或非法时回退默认（reasoningEffort 只认 max）', () => {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'config', 'session-thinking.json'),
      JSON.stringify({ reasoningEffort: 'low' }),
      'utf8',
    )
    expect(loadStoredThinkingPrefs()).toEqual({ thinkingEnabled: true, reasoningEffort: 'high' })
  })
})
