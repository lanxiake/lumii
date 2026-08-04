/**
 * FeishuSessionStore - 持久化飞书机器人 App 凭证到 userData。
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { FeishuDomain } from './feishu-app-registration.js'

export interface FeishuSession {
  appId: string
  appSecret: string
  domain: FeishuDomain
  /** 扫码用户 open_id（可选，用于默认 allowlist） */
  openId?: string
  loginAt: number
}

/**
 * 飞书会话本地存储。
 */
export class FeishuSessionStore {
  private sessionFilePath: string

  constructor() {
    this.sessionFilePath = join(app.getPath('userData'), 'feishu-session.json')
  }

  /**
   * 保存会话凭证。
   */
  async saveSession(session: FeishuSession): Promise<void> {
    try {
      await fs.writeFile(this.sessionFilePath, JSON.stringify(session, null, 2), 'utf8')
    } catch (err) {
      console.error('[FeishuSessionStore] Failed to save session:', err)
    }
  }

  /**
   * 读取会话；损坏或字段不全时返回 null。
   */
  async loadSession(): Promise<FeishuSession | null> {
    try {
      const data = await fs.readFile(this.sessionFilePath, 'utf8')
      const session = JSON.parse(data) as FeishuSession
      if (!session.appId?.trim() || !session.appSecret?.trim()) return null
      if (session.domain !== 'lark' && session.domain !== 'feishu') {
        session.domain = 'feishu'
      }
      return session
    } catch {
      return null
    }
  }

  /**
   * 清除本地会话。
   */
  async clearSession(): Promise<void> {
    try {
      await fs.unlink(this.sessionFilePath)
    } catch {
      // ignore
    }
  }
}
