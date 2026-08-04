/**
 * ConfigManager - 统一配置管理
 *
 * 负责加载、保存、合并配置
 * 支持多层配置优先级：环境变量 > 用户配置 > 默认配置
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import type { DirectoryManager } from './directory-manager'
import type { Config, ServerConfig, AppConfig, LogConfig, PartialConfig } from './config/types'
import { DEFAULT_CONFIG } from './config/types'

const log = {
  info: (...args: unknown[]) => console.log('[ConfigManager]', ...args),
  error: (...args: unknown[]) => console.error('[ConfigManager]', ...args),
  warn: (...args: unknown[]) => console.warn('[ConfigManager]', ...args),
}

/**
 * 配置管理器
 */
export class ConfigManager {
  private config: Config | null = null
  private configPath: string | null = null

  constructor(private directoryManager: DirectoryManager) {}

  /**
   * 初始化配置管理器
   */
  async initialize(): Promise<Config> {
    log.info('初始化配置管理器')

    // 获取配置目录
    const dirs = this.directoryManager.getDirectories()
    this.configPath = join(dirs.config, 'app.json')

    // 加载配置
    this.config = await this.loadConfig()

    log.info('配置管理器初始化完成')
    return this.config
  }

  /**
   * 加载配置
   * 优先级：环境变量 > 用户配置文件 > 默认配置
   */
  private async loadConfig(): Promise<Config> {
    // 1. 从默认配置开始
    let config: Config = JSON.parse(JSON.stringify(DEFAULT_CONFIG))

    // 2. 尝试加载用户配置文件
    if (this.configPath) {
      try {
        const content = await fs.readFile(this.configPath, 'utf-8')
        const userConfig = JSON.parse(content) as Partial<Config>
        config = this.mergeConfig(config, userConfig)
        log.info(`已加载用户配置: ${this.configPath}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn('加载用户配置失败，使用默认配置:', error)
        }
      }
    }

    // 3. 应用环境变量覆盖
    config = this.applyEnvironmentOverrides(config)

    return config
  }

  /**
   * 合并配置
   */
  private mergeConfig(base: Config, override: PartialConfig): Config {
    return {
      server: this.mergeSection(base.server, override.server),
      app: this.mergeSection(base.app, override.app),
      log: this.mergeSection(base.log, override.log),
    }
  }

  /**
   * 合并单个配置节，过滤掉 undefined 值
   */
  private mergeSection<T extends object>(base: T, override: Partial<T> | undefined): T {
    if (!override) return base
    const result = { ...base }
    for (const [key, value] of Object.entries(override)) {
      if (value !== undefined) {
        (result as Record<string, unknown>)[key] = value
      }
    }
    return result
  }

  /**
   * 应用环境变量覆盖
   */
  private applyEnvironmentOverrides(config: Config): Config {
    const result = { ...config }

    // 服务器配置
    if (process.env.MTBOT_API_URL) {
      result.server.apiUrl = process.env.MTBOT_API_URL
      log.info(`环境变量覆盖 API URL: ${result.server.apiUrl}`)
    }
    if (process.env.MTBOT_GATEWAY_URL) {
      result.server.gatewayUrl = process.env.MTBOT_GATEWAY_URL
      log.info(`环境变量覆盖 Gateway URL: ${result.server.gatewayUrl}`)
    }

    // 应用配置
    if (process.env.MTBOT_LANGUAGE) {
      result.app.language = process.env.MTBOT_LANGUAGE as 'zh-CN' | 'en-US'
    }
    if (process.env.MTBOT_THEME) {
      result.app.theme = process.env.MTBOT_THEME as 'light' | 'dark' | 'auto'
    }
    if (process.env.MTBOT_WORKSPACE_DIR) {
      result.app.workspaceDirectory = process.env.MTBOT_WORKSPACE_DIR
    }
    if (process.env.MTBOT_CODING_DEV_ACP_WORKSPACE) {
      result.app.codingDevAcpWorkspace = process.env.MTBOT_CODING_DEV_ACP_WORKSPACE
    }

    // 日志配置
    if (process.env.MTBOT_LOG_LEVEL) {
      result.log.level = process.env.MTBOT_LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error'
    }

    return result
  }

  /**
   * 保存配置
   */
  async saveConfig(config: PartialConfig): Promise<void> {
    if (!this.config || !this.configPath) {
      throw new Error('配置管理器未初始化')
    }

    // 合并配置
    this.config = this.mergeConfig(this.config, config)

    // 写入文件
    try {
      await fs.writeFile(
        this.configPath,
        JSON.stringify(this.config, null, 2),
        'utf-8'
      )
      log.info(`配置已保存: ${this.configPath}`)
    } catch (error) {
      log.error('保存配置失败:', error)
      throw error
    }
  }

  /**
   * 获取完整配置
   */
  getConfig(): Config {
    if (!this.config) {
      throw new Error('配置管理器未初始化')
    }
    return this.config
  }

  /**
   * 获取服务器配置
   */
  getServerConfig(): ServerConfig {
    return this.getConfig().server
  }

  /**
   * 获取应用配置
   */
  getAppConfig(): AppConfig {
    return this.getConfig().app
  }

  /**
   * 获取日志配置
   */
  getLogConfig(): LogConfig {
    return this.getConfig().log
  }

  /**
   * 更新服务器配置
   */
  async updateServerConfig(config: Partial<ServerConfig>): Promise<void> {
    await this.saveConfig({ server: config })
  }

  /**
   * 更新应用配置
   */
  async updateAppConfig(config: Partial<AppConfig>): Promise<void> {
    await this.saveConfig({ app: config })
  }

  /**
   * 更新日志配置
   */
  async updateLogConfig(config: Partial<LogConfig>): Promise<void> {
    await this.saveConfig({ log: config })
  }

  /**
   * 重置为默认配置
   */
  async resetToDefault(): Promise<void> {
    this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG))
    if (this.configPath) {
      await fs.writeFile(
        this.configPath,
        JSON.stringify(this.config, null, 2),
        'utf-8'
      )
      log.info('配置已重置为默认值')
    }
  }
}
