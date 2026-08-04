/**
 * WeixinSessionStore - Persists WeChat Personal (iLink) session to userData directory.
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'

export interface WeixinSession {
  /** ilink_bot_id returned after login */
  userId: string
  /** Bearer token for authenticated API calls */
  botToken: string
  /** Dynamic base URL returned by the server (may differ from default) */
  baseUrl?: string
  loginAt: number
  /**
   * Token expiry timestamp (ms since epoch).
   * iLink does not advertise an expiry date; we default to 30 days.
   * On getupdates 401/403 the session is invalidated regardless of this value.
   */
  expiresAt?: number
}

export class WeixinSessionStore {
  private sessionFilePath: string

  constructor() {
    const userDataDir = app.getPath('userData')
    this.sessionFilePath = join(userDataDir, 'weixin-session.json')
  }

  async saveSession(session: WeixinSession): Promise<void> {
    try {
      await fs.writeFile(this.sessionFilePath, JSON.stringify(session, null, 2), 'utf8')
    } catch (err) {
      console.error('[WeixinSessionStore] Failed to save session:', err)
    }
  }

  async loadSession(): Promise<WeixinSession | null> {
    try {
      const data = await fs.readFile(this.sessionFilePath, 'utf8')
      const session = JSON.parse(data) as WeixinSession
      // Treat sessions older than 30 days as expired even if expiresAt is absent
      const expiresAt = session.expiresAt ?? session.loginAt + 30 * 24 * 60 * 60 * 1000
      if (Date.now() > expiresAt) {
        console.info('[WeixinSessionStore] Saved session is expired, discarding')
        await this.clearSession()
        return null
      }
      return session
    } catch {
      return null
    }
  }

  async clearSession(): Promise<void> {
    try {
      await fs.unlink(this.sessionFilePath)
    } catch {
      // Ignore: file may not exist
    }
  }

  getSessionFilePath(): string {
    return this.sessionFilePath
  }
}
