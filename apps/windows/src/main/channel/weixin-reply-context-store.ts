/**
 * 微信 iLink context_token 持久化存储（伪 Push 依赖）
 *
 * 路径默认：~/.lumii/channel/weixin-reply-contexts.json
 * 凭证禁止 info 级日志。
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  TOKEN_STALE_MS,
  type WeixinReplyContextRecord,
} from './outbound-types'

export { TOKEN_STALE_MS }

/**
 * 读写微信 reply context；构造时从磁盘加载，upsert 后同步落盘。
 */
export class WeixinReplyContextStore {
  private records = new Map<string, WeixinReplyContextRecord>()

  /**
   * @param filePath JSON 持久化绝对路径
   */
  constructor(private readonly filePath: string) {
    this.loadFromDisk()
  }

  /**
   * 插入或更新一条用户的 context_token。
   * 与已有记录合并：新入站未携带的可选字段（botToken / ilinkBaseUrl / nickname）保留旧值。
   */
  upsert(record: WeixinReplyContextRecord): void {
    const channelUserId = record.channelUserId.trim()
    if (!channelUserId || !record.contextToken) return
    const prev = this.records.get(channelUserId)
    const botToken = record.botToken ?? prev?.botToken
    const ilinkBaseUrl = record.ilinkBaseUrl ?? prev?.ilinkBaseUrl
    const lastNickname = record.lastNickname ?? prev?.lastNickname
    this.records.set(channelUserId, {
      channelUserId,
      contextToken: record.contextToken,
      updatedAt: record.updatedAt || Date.now(),
      ...(botToken ? { botToken } : {}),
      ...(ilinkBaseUrl ? { ilinkBaseUrl } : {}),
      ...(lastNickname ? { lastNickname } : {}),
    })
    this.persist()
  }

  /**
   * 按 channelUserId 读取记录。
   */
  get(channelUserId: string): WeixinReplyContextRecord | undefined {
    return this.records.get(channelUserId.trim())
  }

  /**
   * 列出全部记录（无序）。
   */
  list(): WeixinReplyContextRecord[] {
    return [...this.records.values()]
  }

  /**
   * 判断 token 是否超过 TOKEN_STALE_MS。
   */
  isStale(channelUserId: string, now: number = Date.now()): boolean {
    const rec = this.get(channelUserId)
    if (!rec) return true
    return now - rec.updatedAt > TOKEN_STALE_MS
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
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue
        const r = item as Partial<WeixinReplyContextRecord>
        if (typeof r.channelUserId !== 'string' || typeof r.contextToken !== 'string') continue
        if (typeof r.updatedAt !== 'number') continue
        this.records.set(r.channelUserId, {
          channelUserId: r.channelUserId,
          contextToken: r.contextToken,
          updatedAt: r.updatedAt,
          ...(typeof r.botToken === 'string' ? { botToken: r.botToken } : {}),
          ...(typeof r.ilinkBaseUrl === 'string' ? { ilinkBaseUrl: r.ilinkBaseUrl } : {}),
          ...(typeof r.lastNickname === 'string' ? { lastNickname: r.lastNickname } : {}),
        })
      }
    } catch {
      this.records.clear()
    }
  }

  /**
   * 将内存表写入磁盘（原子写：先 tmp 再 rename）。
   */
  private persist(): void {
    const dir = path.dirname(this.filePath)
    fs.mkdirSync(dir, { recursive: true })
    const payload = JSON.stringify([...this.records.values()], null, 2)
    const tmp = `${this.filePath}.${process.pid}.tmp`
    fs.writeFileSync(tmp, payload, 'utf8')
    fs.renameSync(tmp, this.filePath)
  }
}
