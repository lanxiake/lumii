/**
 * WeixinReplyContextStore 单测：upsert/list、stale 判定、磁盘持久化。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WeixinReplyContextStore, TOKEN_STALE_MS } from './weixin-reply-context-store'

describe('WeixinReplyContextStore', () => {
  let tmpDir: string
  let filePath: string
  let store: WeixinReplyContextStore

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-ctx-'))
    filePath = path.join(tmpDir, 'weixin-reply-contexts.json')
    store = new WeixinReplyContextStore(filePath)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('upsert 后 get/list 可读回', () => {
    store.upsert({
      channelUserId: 'wxid_abc',
      contextToken: 'tok-1',
      botToken: 'bot-1',
      ilinkBaseUrl: 'https://ilink.example',
      lastNickname: '张三',
      updatedAt: 1_700_000_000_000,
    })
    const got = store.get('wxid_abc')
    expect(got?.contextToken).toBe('tok-1')
    expect(got?.lastNickname).toBe('张三')
    expect(store.list()).toHaveLength(1)
  })

  it('updatedAt 超过 24h 判定为 stale', () => {
    const now = Date.now()
    store.upsert({
      channelUserId: 'wxid_old',
      contextToken: 'tok-old',
      updatedAt: now - TOKEN_STALE_MS - 1,
    })
    expect(store.isStale('wxid_old', now)).toBe(true)
    store.upsert({
      channelUserId: 'wxid_fresh',
      contextToken: 'tok-new',
      updatedAt: now - 60_000,
    })
    expect(store.isStale('wxid_fresh', now)).toBe(false)
  })

  it('落盘后 reload 能读回', () => {
    store.upsert({
      channelUserId: 'wxid_abc',
      contextToken: 'tok-persist',
      updatedAt: Date.now(),
    })
    const reloaded = new WeixinReplyContextStore(filePath)
    expect(reloaded.get('wxid_abc')?.contextToken).toBe('tok-persist')
  })

  it('upsert 缺 botToken/ilinkBaseUrl 时保留已有凭证', () => {
    store.upsert({
      channelUserId: 'wxid_abc',
      contextToken: 'tok-1',
      botToken: 'bot-keep',
      ilinkBaseUrl: 'https://ilink.example',
      lastNickname: '张三',
      updatedAt: 1_700_000_000_000,
    })
    store.upsert({
      channelUserId: 'wxid_abc',
      contextToken: 'tok-2',
      updatedAt: 1_700_000_100_000,
    })
    const got = store.get('wxid_abc')
    expect(got?.contextToken).toBe('tok-2')
    expect(got?.botToken).toBe('bot-keep')
    expect(got?.ilinkBaseUrl).toBe('https://ilink.example')
    expect(got?.lastNickname).toBe('张三')
  })
})
