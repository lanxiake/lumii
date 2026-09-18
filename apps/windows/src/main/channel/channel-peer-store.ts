/**
 * 渠道入站 peer 持久化（channel_list 的「最近活跃会话」来源）
 *
 * 路径默认：~/.lumii/channel/channel-peers.json
 *
 * 只持久化 qbot / wecom（被动回复窗口渠道，重启后窗口内的 peer 仍可投递）。
 *
 * feishu / weixin 不落盘：飞书 peer 来自登录 openId（无需记录）；
 * 微信 token 需每次入站刷新，恢复陈旧 token 只会把消息发到失效会话上，
 * 故重启后不恢复（详见 docs/design/渠道与CLI/2026-08-14-渠道出站Hub设计.md §7.5）。
 */

import fs from 'node:fs'
import path from 'node:path'
import type { ChannelPeer } from './outbound-types'

/** 允许跨重启恢复的渠道（被动回复窗口语义） */
const PERSISTABLE_CHANNELS = new Set(['qbot', 'wecom'])

/** 持久化的单条入站记录 */
export interface ChannelPeerRecord {
  channel: string
  peerId: string
  label?: string
  chatType?: string
  lastInboundAt: number
}

/**
 * 读写渠道 peer 记录；构造时从磁盘加载，record 后同步落盘。
 */
export class ChannelPeerStore {
  private records: ChannelPeerRecord[] = []

  /**
   * @param filePath JSON 持久化绝对路径
   */
  constructor(private readonly filePath: string) {
    this.loadFromDisk()
  }

  /**
   * 记录（或刷新）一个入站 peer；不可持久化渠道静默跳过。
   * 落盘只保存 PERSISTABLE_CHANNELS；其它渠道的 peer 由各 Provider 自己持有。
   */
  record(record: ChannelPeerRecord): void {
    const channel = record.channel.trim()
    const peerId = record.peerId.trim()
    if (!channel || !peerId) return
    if (!PERSISTABLE_CHANNELS.has(channel)) return
    const next: ChannelPeerRecord = {
      channel,
      peerId,
      lastInboundAt: record.lastInboundAt || Date.now(),
      ...(record.label ? { label: record.label } : {}),
      ...(record.chatType ? { chatType: record.chatType } : {}),
    }
    this.records = this.records.filter(
      (r) => !(r.channel === channel && r.peerId === peerId),
    )
    this.records.push(next)
    this.persist()
  }

  /**
   * 某渠道的全部 peer（输入顺序 = 入站时间升序；Provider 只做展示）。
   */
  listByChannel(channel: string): ChannelPeerRecord[] {
    return this.records.filter((r) => r.channel === channel)
  }

  /**
   * 转为 Provider 快照形状的 ChannelPeer（恢复时 lastInboundAt 由调用方覆盖为 now）。
   */
  static toPeers(records: readonly ChannelPeerRecord[], now: number): ChannelPeer[] {
    return records.map((r) => ({
      id: r.peerId,
      ...(r.label ? { label: r.label } : {}),
      canSend: true,
      lastInboundAt: now,
    }))
  }

  /**
   * 从磁盘加载；文件不存在或损坏时视为空表。
   */
  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.filePath)) return
      const raw = fs.readFileSync(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return
      const records: ChannelPeerRecord[] = []
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue
        const r = item as Partial<ChannelPeerRecord>
        if (typeof r.channel !== 'string' || typeof r.peerId !== 'string') continue
        if (!PERSISTABLE_CHANNELS.has(r.channel)) continue
        if (typeof r.lastInboundAt !== 'number') continue
        records.push({
          channel: r.channel,
          peerId: r.peerId,
          lastInboundAt: r.lastInboundAt,
          ...(typeof r.label === 'string' ? { label: r.label } : {}),
          ...(typeof r.chatType === 'string' ? { chatType: r.chatType } : {}),
        })
      }
      this.records = records
    } catch {
      this.records = []
    }
  }

  /**
   * 原子落盘：先写 tmp 再 rename。
   */
  private persist(): void {
    const dir = path.dirname(this.filePath)
    fs.mkdirSync(dir, { recursive: true })
    const payload = JSON.stringify(this.records, null, 2)
    const tmp = `${this.filePath}.${process.pid}.tmp`
    fs.writeFileSync(tmp, payload, 'utf8')
    fs.renameSync(tmp, this.filePath)
  }
}
