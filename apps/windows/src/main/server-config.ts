/**
 * 服务器配置加载模块
 *
 * 从环境变量文件 (.env) 中读取服务器地址
 * 支持优先级：环境变量 > .env 文件 > 配置文件 > 默认值
 */

import { join } from 'path'
import { promises as fs } from 'fs'
import dotenv from 'dotenv'
export type { ServerConfig } from './config/types'
import type { ServerConfig } from './config/types'
import { DEFAULT_CONFIG } from './config/types'

/** 开发环境 gateway secret 期望最小长度（过短通常表示 .env 中 # 被当作注释截断） */
const GATEWAY_SECRET_MIN_LENGTH = 32

/**
 * 解析 Gateway 内部调用密钥（与 api-server / Gateway 环境变量名对齐）
 */
export function resolveGatewaySecretFromEnv(): string | null {
  const secret =
    process.env.API_SERVER_GATEWAY_SECRET?.trim() ||
    process.env.MTBOT_GATEWAY_SECRET?.trim() ||
    process.env.GATEWAY_SECRET?.trim() ||
    null

  if (secret && secret.length < GATEWAY_SECRET_MIN_LENGTH) {
    console.warn(
      `[Config] API_SERVER_GATEWAY_SECRET 长度=${secret.length}，疑似被 .env 中未加引号的 # 截断；请用双引号包裹完整密钥`,
    )
  }

  return secret
}

/**
 * 规范化 SearXNG 基址（裸域名 mtbot.top 无法访问搜索，须用 www）
 */
function normalizeSearxngBaseUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  return trimmed
    .replace(/^http:\/\/mtbot\.top\//i, 'http://www.mtbot.top/')
    .replace(/^https:\/\/mtbot\.top\//i, 'https://www.mtbot.top/')
    .replace(/\/+$/, '')
}

/**
 * 依次加载多个 .env 文件（去重后按顺序合并）。
 * 后加载的文件在 override=true 时可覆盖先加载的同名变量。
 */
async function loadEnvFiles(
  entries: Array<{ path: string; override: boolean }>,
): Promise<void> {
  const loaded = new Set<string>()

  for (const entry of entries) {
    try {
      await fs.access(entry.path)
    } catch {
      continue
    }

    const resolved = entry.path
    if (loaded.has(resolved)) {
      continue
    }
    loaded.add(resolved)

    dotenv.config({ path: entry.path, override: entry.override, quiet: true })
    console.log(
      `[Config] 已加载环境变量文件：${entry.path}${entry.override ? '（可覆盖）' : ''}`,
    )
  }
}

/**
 * 从环境变量和配置文件中加载服务器配置
 * 优先级：进程环境变量 > .env 文件（后者覆盖前者）> 配置文件 > 默认值
 */
export async function loadServerConfig(): Promise<ServerConfig> {
  // 0. 分层加载 .env：根目录共享配置 → 客户端/生产专用配置（后者可覆盖）
  await loadEnvFiles([
    { path: join(__dirname, '../../../../.env'), override: false },
    { path: join(process.cwd(), '.env'), override: true },
    { path: join(__dirname, '../../.env'), override: true },
    { path: join(process.resourcesPath || '', '.env'), override: true },
  ])

  if (process.env.SEARXNG_BASE_URL) {
    process.env.SEARXNG_BASE_URL = normalizeSearxngBaseUrl(process.env.SEARXNG_BASE_URL) ?? ''
  }

  const searchConfigured =
    !!process.env.LANGSEARCH_API_KEY?.trim() || !!process.env.SEARXNG_BASE_URL?.trim()
  console.log(
    `[Config] 搜索引擎: LANGSEARCH=${process.env.LANGSEARCH_API_KEY ? '已配置' : '未配置'} SEARXNG=${process.env.SEARXNG_BASE_URL ?? '未配置'}`,
  )
  if (!searchConfigured) {
    console.warn(
      '[Config] web_search 不可用：请在 apps/windows/.env 配置 SEARXNG_BASE_URL 或 LANGSEARCH_API_KEY',
    )
  }

  // 1. 检查进程环境变量（最高优先级）
  if (process.env.MTBOT_API_URL || process.env.MTBOT_GATEWAY_URL) {
    console.log('[Config] 使用环境变量配置（独立版本地模式）')
    return {
      apiUrl: process.env.MTBOT_API_URL || DEFAULT_CONFIG.server.apiUrl,
      gatewayUrl: process.env.MTBOT_GATEWAY_URL || DEFAULT_CONFIG.server.gatewayUrl,
    }
  }

  // 2. 尝试从配置文件中读取
  // 开发环境：从源代码目录加载
  // 生产环境：从打包后的 resources 目录加载
  const configPaths = [
    // 生产环境路径
    join(process.resourcesPath || '', 'config', 'server-config.json'),
    // 开发环境路径（相对于 main 进程的位置）
    join(__dirname, '../../config/server-config.json'),
    // 备用开发环境路径
    join(process.cwd(), 'config/server-config.json'),
  ]

  for (const configPath of configPaths) {
    try {
      const content = await fs.readFile(configPath, 'utf-8')
      const config = JSON.parse(content) as ServerConfig

      // 验证配置有效性（独立版仅作本地占位，降噪：不打印云端 Gateway 地址）
      if (config.apiUrl && config.gatewayUrl) {
        const isLocal =
          /127\.0\.0\.1|localhost/i.test(config.gatewayUrl) ||
          /127\.0\.0\.1|localhost/i.test(config.apiUrl)
        if (isLocal) {
          console.log(`[Config] 独立版本地配置已加载`)
        } else {
          console.log(`[Config] 已加载服务器配置（已忽略云端网关自动连接）`)
        }
        return config
      }
    } catch (error) {
      // 继续尝试下一个路径
      continue
    }
  }

  // 3. 所有路径都失败，使用默认配置
  console.log('[Config] 使用独立版本地默认配置')
  return DEFAULT_CONFIG.server
}
