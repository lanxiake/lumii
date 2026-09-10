/**
 * QbotSessionStore - 持久化 QQ 机器人凭证到 userData。
 *
 * AppSecret 仅主进程持有，不回传渲染进程明文；日志脱敏。
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'

export interface QbotSession {
  appId: string
  appSecret: string
  loginAt: number
}

export class QbotSessionStore {
  private sessionFilePath: string

  constructor() {
    this.sessionFilePath = join(app.getPath('userData'), 'qbot-session.json')
  }

  async saveSession(session: QbotSession): Promise<void> {
    try {
      await fs.writeFile(this.sessionFilePath, JSON.stringify(session, null, 2), 'utf8')
    } catch (err) {
      console.error('[QbotSessionStore] Failed to save session:', err)
    }
  }

  async loadSession(): Promise<QbotSession | null> {
    try {
      const data = await fs.readFile(this.sessionFilePath, 'utf8')
      const session = JSON.parse(data) as QbotSession
      if (!session.appId?.trim() || !session.appSecret?.trim()) return null
      return session
    } catch {
      return null
    }
  }

  async clearSession(): Promise<void> {
    try {
      await fs.unlink(this.sessionFilePath)
    } catch {
      // ignore
    }
  }
}
