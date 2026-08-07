/**
 * 语音引擎配置持久化
 * 保存到 {configDir}/voice-engine-config.json，跨重启保留用户设置
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { resolveSharedConfigDir } from '../paths.js'
import type { VoiceEngineConfig } from '../../shared/voice-events.js'
import { DEFAULT_VOICE_ENGINE_CONFIG } from '../../shared/voice-events.js'

const log = {
  info: (...args: unknown[]) => console.log('[VoiceConfigStore]', ...args),
  warn: (...args: unknown[]) => console.warn('[VoiceConfigStore]', ...args),
  error: (...args: unknown[]) => console.error('[VoiceConfigStore]', ...args),
}

function getConfigPath(): string {
  return path.join(resolveSharedConfigDir(), 'voice-engine-config.json')
}

/** 深合并，只合并已知字段，忽略未知字段；并迁移旧「用 Base 变体表示克隆」配置 */
function mergeWithDefaults(saved: Partial<VoiceEngineConfig>): VoiceEngineConfig {
  const ttsSaved = { ...(saved.tts ?? {}) } as VoiceEngineConfig['tts'] & {
    qwen3Variant?: string
  }
  // 旧版：qwen3Variant 为 *-base 即表示克隆出声 → 拆到独立开关
  if (
    ttsSaved.qwen3CloneEnabled === undefined &&
    (ttsSaved.qwen3Variant === '0.6b-base' || ttsSaved.qwen3Variant === '1.7b-base')
  ) {
    ttsSaved.qwen3CloneEnabled = true
    ttsSaved.qwen3CloneVariant = ttsSaved.qwen3Variant as '0.6b-base' | '1.7b-base'
    ttsSaved.qwen3Variant = '0.6b-custom'
  }

  return {
    asr: { ...DEFAULT_VOICE_ENGINE_CONFIG.asr, ...saved.asr },
    tts: { ...DEFAULT_VOICE_ENGINE_CONFIG.tts, ...ttsSaved },
    vad: { ...DEFAULT_VOICE_ENGINE_CONFIG.vad, ...saved.vad },
    autoMuteMicWhileSpeaking:
      saved.autoMuteMicWhileSpeaking ?? DEFAULT_VOICE_ENGINE_CONFIG.autoMuteMicWhileSpeaking,
  }
}

/**
 * 从磁盘加载语音引擎配置，缺失时返回默认值
 */
export async function loadVoiceEngineConfig(): Promise<VoiceEngineConfig> {
  const configPath = getConfigPath()
  try {
    const content = await fs.readFile(configPath, 'utf-8')
    const saved = JSON.parse(content) as Partial<VoiceEngineConfig>
    const config = mergeWithDefaults(saved)
    log.info(`[loadVoiceEngineConfig] 已加载: ${configPath}`)
    return config
  } catch (e: any) {
    if (e.code !== 'ENOENT') {
      log.warn(`[loadVoiceEngineConfig] 读取失败，使用默认值: ${e.message}`)
    }
    return { ...DEFAULT_VOICE_ENGINE_CONFIG }
  }
}

/**
 * 将语音引擎配置保存到磁盘
 */
export async function saveVoiceEngineConfig(config: VoiceEngineConfig): Promise<void> {
  const configPath = getConfigPath()
  try {
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8')
    log.info(`[saveVoiceEngineConfig] 已保存: ${configPath}`)
  } catch (e) {
    log.error(`[saveVoiceEngineConfig] 保存失败: ${(e as Error).message}`)
    throw e
  }
}
