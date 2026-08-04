/**
 * WecomSessionStore - 持久化企业微信 AI Bot（WebSocket）凭证到 userData。
 *
 * 扫码成功后得到 botId + secret，与 Webhook 自建应用凭证无关。
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'

export interface WecomSession {
  /** 企业微信 AI 机器人 Bot ID */
  botId: string
  /** 企业微信 AI 机器人 Secret（仅主进程持有，不回传渲染进程明文） */
  secret: string
  /** 扫码/接入时间 */
  loginAt: number
}

export class WecomSessionStore {
  private sessionFilePath: string

  constructor() {
    const userDataDir = app.getPath('userData')
    this.sessionFilePath = join(userDataDir, 'wecom-session.json')
  }

  /**
   * 保存 Bot 会话凭证。
   */
  async saveSession(session: WecomSession): Promise<void> {
    try {
      await fs.writeFile(this.sessionFilePath, JSON.stringify(session, null, 2), 'utf8')
    } catch (err) {
      console.error('[WecomSessionStore] Failed to save session:', err)
    }
  }

  /**
   * 读取已保存的 Bot 会话；文件损坏或不存在时返回 null。
   */
  async loadSession(): Promise<WecomSession | null> {
    try {
      const data = await fs.readFile(this.sessionFilePath, 'utf8')
      const session = JSON.parse(data) as WecomSession
      if (!session.botId?.trim() || !session.secret?.trim()) {
        return null
      }
      return session
    } catch {
      return null
    }
  }

  /**
   * 清除本地 Bot 会话。
   */
  async clearSession(): Promise<void> {
    try {
      await fs.unlink(this.sessionFilePath)
    } catch {
      // Ignore: file may not exist
    }
  }

  /**
   * 返回会话文件路径（调试用）。
   */
  getSessionFilePath(): string {
    return this.sessionFilePath
  }
}
