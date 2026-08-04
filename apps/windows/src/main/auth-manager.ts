/**
 * AuthManager - 认证状态管理
 *
 * 使用 Electron safeStorage（Windows DPAPI）加密存储 refreshToken，
 * 避免明文存储在 localStorage（Chromium IndexedDB）中。
 *
 * 存储位置：客户端数据根下 config/auth.json（默认 ~/.lumii/config/auth.json）
 * 加密方式：safeStorage.encryptString（Windows DPAPI，与当前用户账户绑定）
 */

import { safeStorage } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'

import { resolveClientStateDir } from './paths'

const log = {
  info: (...args: unknown[]) => console.log('[AuthManager]', ...args),
  error: (...args: unknown[]) => console.error('[AuthManager]', ...args),
  warn: (...args: unknown[]) => console.warn('[AuthManager]', ...args),
}

interface AuthState {
  encryptedRefreshToken?: string | null
}

export class AuthManager {
  private configPath: string
  private state: AuthState = {}

  constructor(configDir?: string) {
    const dir = configDir ?? join(resolveClientStateDir(), 'config')
    this.configPath = join(dir, 'auth.json')
  }

  async initialize(): Promise<void> {
    try {
      const data = await fs.readFile(this.configPath, 'utf-8')
      this.state = JSON.parse(data) as AuthState
      log.info('认证状态已加载')
    } catch {
      this.state = {}
      log.info('无已保存的认证状态，使用空状态')
    }
  }

  /**
   * 保存 refreshToken（加密存储）
   */
  async saveRefreshToken(token: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('safeStorage 加密不可用（DPAPI 未就绪）')
    }
    const encrypted = safeStorage.encryptString(token)
    this.state = { encryptedRefreshToken: encrypted.toString('base64') }
    await this.persist()
    log.info('refreshToken 已加密保存')
  }

  /**
   * 获取 refreshToken（解密）
   */
  getRefreshToken(): string | null {
    if (!this.state.encryptedRefreshToken) return null
    if (!safeStorage.isEncryptionAvailable()) {
      log.warn('safeStorage 不可用，无法解密 refreshToken')
      return null
    }
    try {
      const buffer = Buffer.from(this.state.encryptedRefreshToken, 'base64')
      return safeStorage.decryptString(buffer)
    } catch (err) {
      log.error('解密 refreshToken 失败:', err)
      return null
    }
  }

  /**
   * 清除 refreshToken
   */
  async clearRefreshToken(): Promise<void> {
    this.state = {}
    await this.persist()
    log.info('refreshToken 已清除')
  }

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(join(this.configPath, '..'), { recursive: true })
      await fs.writeFile(this.configPath, JSON.stringify(this.state, null, 2), 'utf-8')
    } catch (err) {
      log.error('持久化认证状态失败:', err)
      throw err
    }
  }
}
