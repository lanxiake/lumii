/**
 * 生图上游配置加载（Draw API + IMAGE_UPSTREAM）
 *
 * 优先级：进程环境变量 > .env（由 loadServerConfig 加载）> draw-config.json > 默认值
 */

import { join } from 'path'
import { promises as fs } from 'fs'

/** 打包/配置文件中的生图上游结构 */
export interface DrawConfigFile {
  drawApiBaseUrl?: string
  drawApiKey?: string
  /** llm-link 等 OpenAI 兼容根地址（含 /v1），用于 gpt-image-2 流式生图 */
  imageUpstreamBaseUrl?: string
  imageUpstreamApiKey?: string
}

/** 默认 Draw API 根地址 */
export const DEFAULT_DRAW_API_BASE_URL = 'https://www.right.codes/draw'

/** 默认 IMAGE_UPSTREAM 根地址 */
export const DEFAULT_IMAGE_UPSTREAM_BASE_URL = 'https://www.llm-link.top/v1'

/**
 * 将配置文件中的字段写入 process.env（仅填补尚未设置的项）。
 * 应在 loadServerConfig() 之后调用，以便 .env 优先生效。
 */
export async function loadDrawConfig(): Promise<void> {
  applyDrawEnvAliases()

  const configPaths = [
    join(process.resourcesPath || '', 'config', 'draw-config.json'),
    join(__dirname, '../../config/draw-config.json'),
    join(process.cwd(), 'config/draw-config.json'),
  ]

  for (const configPath of configPaths) {
    try {
      const content = await fs.readFile(configPath, 'utf-8')
      const config = JSON.parse(content) as DrawConfigFile

      if (!process.env.MTBOT_DRAW_API_BASE_URL?.trim() && config.drawApiBaseUrl?.trim()) {
        process.env.MTBOT_DRAW_API_BASE_URL = config.drawApiBaseUrl.trim()
      }
      if (!process.env.MTBOT_DRAW_API_KEY?.trim() && config.drawApiKey?.trim()) {
        process.env.MTBOT_DRAW_API_KEY = config.drawApiKey.trim()
      }
      if (!process.env.MTBOT_IMAGE_UPSTREAM_BASE_URL?.trim() && config.imageUpstreamBaseUrl?.trim()) {
        process.env.MTBOT_IMAGE_UPSTREAM_BASE_URL = config.imageUpstreamBaseUrl.trim()
      }
      if (!process.env.MTBOT_IMAGE_UPSTREAM_API_KEY?.trim() && config.imageUpstreamApiKey?.trim()) {
        process.env.MTBOT_IMAGE_UPSTREAM_API_KEY = config.imageUpstreamApiKey.trim()
      }

      if (
        process.env.MTBOT_DRAW_API_KEY?.trim() ||
        process.env.MTBOT_IMAGE_UPSTREAM_API_KEY?.trim()
      ) {
        console.log(`[DrawConfig] 已从配置文件加载: ${configPath}`)
        console.log(
          `[DrawConfig] draw=${process.env.MTBOT_DRAW_API_BASE_URL ?? DEFAULT_DRAW_API_BASE_URL} ` +
            `upstream=${process.env.MTBOT_IMAGE_UPSTREAM_BASE_URL ?? '(未配置)'}`,
        )
        return
      }
    } catch {
      continue
    }
  }

  if (!process.env.MTBOT_DRAW_API_KEY?.trim() && !process.env.MTBOT_IMAGE_UPSTREAM_API_KEY?.trim()) {
    console.warn(
      '[DrawConfig] 未找到生图 Key：请配置 draw-config.json（drawApiKey 或 imageUpstreamApiKey）或环境变量',
    )
  }
}

/**
 * 统一 MTBOT_* / Gateway 同名环境变量别名，便于与 Gateway image-generate-http 对齐。
 */
function applyDrawEnvAliases(): void {
  const pairs: Array<[target: string, sources: string[]]> = [
    ['MTBOT_DRAW_API_KEY', ['DRAW_API_KEY']],
    ['MTBOT_DRAW_API_BASE_URL', ['DRAW_API_BASE_URL']],
    ['MTBOT_IMAGE_UPSTREAM_API_KEY', ['IMAGE_UPSTREAM_API_KEY', 'OPENAI_API_KEY']],
    ['MTBOT_IMAGE_UPSTREAM_BASE_URL', ['IMAGE_UPSTREAM_BASE_URL', 'OPENAI_API_BASE']],
  ]

  for (const [target, sources] of pairs) {
    if (process.env[target]?.trim()) continue
    for (const source of sources) {
      const value = process.env[source]?.trim()
      if (value) {
        process.env[target] = value
        break
      }
    }
  }
}
