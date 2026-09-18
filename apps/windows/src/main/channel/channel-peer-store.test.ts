/**
 * ChannelPeerStore 单测：record/listByChannel、按渠道过滤、磁盘持久化、损坏容错。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChannelPeerStore } from './channel-peer-store'

describe('ChannelPeerStore', () => {
  let tmpDir: string
  let filePath: string
  let store: ChannelPeerStore

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-peers-'))
    filePath = path.join(tmpDir, 'channel-peers.json')
    store = new ChannelPeerStore(filePath)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('record 后 listByChannel 可读回，同 peer 重复 record 去重', () => {
    store.record({ channel: 'qbot', peerId: 'openid_1', label: 'QQ用户', lastInboundAt: 1000 })
    store.record({ channel: 'qbot', peerId: 'openid_1', label: '新名字', lastInboundAt: 2000 })
    const peers = store.listByChannel('qbot')
    expect(peers).toHaveLength(1)
    expect(peers[0]?.label).toBe('新名字')
    expect(peers[0]?.lastInboundAt).toBe(2000)
  })

  it('非持久化渠道（feishu/weixin）静默跳过，不写内存也不落盘', () => {
    store.record({ channel: 'weixin', peerId: 'wxid_a', lastInboundAt: 1000 })
    store.record({ channel: 'feishu', peerId: 'ou_a', lastInboundAt: 1000 })
    expect(store.listByChannel('weixin')).toHaveLength(0)
    expect(fs.existsSync(filePath)).toBe(false)
  })

  it('落盘后 reload 能读回（含 chatType / label）', () => {
    store.record({
      channel: 'qbot',
      peerId: 'group_openid_1',
      label: '小组(群)',
      chatType: 'group',
      lastInboundAt: 3000,
    })
    const reloaded = new ChannelPeerStore(filePath)
    const peers = reloaded.listByChannel('qbot')
    expect(peers).toHaveLength(1)
    expect(peers[0]?.peerId).toBe('group_openid_1')
    expect(peers[0]?.chatType).toBe('group')
    expect(peers[0]?.label).toBe('小组(群)')
  })

  it('磁盘内容损坏时视为空表', () => {
    fs.writeFileSync(filePath, '{ not json', 'utf8')
    const reloaded = new ChannelPeerStore(filePath)
    expect(reloaded.listByChannel('qbot')).toHaveLength(0)
  })

  it('加载时丢弃非持久化渠道与缺字段的脏数据', () => {
    fs.writeFileSync(
      filePath,
      JSON.stringify([
        { channel: 'weixin', peerId: 'wxid_a', lastInboundAt: 1 },
        { channel: 'qbot', peerId: 'openid_1', lastInboundAt: 2 },
        { channel: 'qbot', lastInboundAt: 3 },
        { channel: 'qbot', peerId: 'openid_2' },
      ]),
      'utf8',
    )
    const reloaded = new ChannelPeerStore(filePath)
    expect(reloaded.listByChannel('qbot')).toHaveLength(1)
    expect(reloaded.listByChannel('qbot')[0]?.peerId).toBe('openid_1')
    expect(reloaded.listByChannel('weixin')).toHaveLength(0)
  })

  it('toPeers 统一恢复为 lastInboundAt=now 且 canSend=true', () => {
    const peers = ChannelPeerStore.toPeers(
      [{ channel: 'wecom', peerId: 'u1', label: '同事', lastInboundAt: 1 }],
      9999,
    )
    expect(peers[0]).toEqual({ id: 'u1', label: '同事', canSend: true, lastInboundAt: 9999 })
  })
})
