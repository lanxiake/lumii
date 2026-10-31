/**
 * 语音引擎配置持久化
 * 保存到 {configDir}/voice-engine-config.json，跨重启保留用户设置
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { resolveSharedConfigDir } from '../../../main/paths.js'
import type { VoiceEngineConfig } from '../../../shared/voice-events.js'
import { DEFAULT_VOICE_ENGINE_CONFIG, isQwen3CloneVariant } from '../../../shared/voice-events.js'

const log = {
  info: (...args: unknown[]) => console.log('[VoiceConfigStore]', ...args),
  warn: (...args: unknown[]) => console.warn('[VoiceConfigStore]', ...args),
  error: (...args: unknown[]) => console.error('[VoiceConfigStore]', ...args),
}

function getConfigPath(): string {
  return path.join(resolveSharedConfigDir(), 'voice-engine-config.json')
}

/**
 * 是否"朗读期间完全闭麦"。
 *
 * 默认值从 true 改成了 false（改成两段式打断：疑似开口先压音，ASR 确认才真打断）。
 * 但**老配置里显式存下的 true 必须保留** —— 那时默认就是 true，用户以为自己处在
 * 默认态，改成 false 等于替他们改了行为。所以：存过就听存的，没存过用新默认。
 */
function resolveAutoMute(saved: Partial<VoiceEngineConfig>): boolean {
  return typeof saved.autoMuteMicWhileSpeaking === 'boolean'
    ? saved.autoMuteMicWhileSpeaking
    : DEFAULT_VOICE_ENGINE_CONFIG.autoMuteMicWhileSpeaking
}

/**
 * 提交窗口：旧版只有单值 `commitWindowMs`，新版拆成 min/max 两端。
 * 老配置读到旧值时映射成 min = 旧值、max = 旧值 × 2（保留原来的等待体感），
 * 之后写回磁盘时会自然落成新字段。
 */
function migrateCommitWindow(
  savedVad: Partial<VoiceEngineConfig['vad']> | undefined,
): Partial<VoiceEngineConfig['vad']> {
  const vad = { ...(savedVad ?? {}) } as VoiceEngineConfig['vad'] & { commitWindowMs?: number }
  const legacy = vad.commitWindowMs
  // 必须在**合并默认值之前**迁移：默认值里已有 commitMinMs，合并后就分不清
  // "用户没配" 和 "用户配的是旧字段" 了。
  if (vad.commitMinMs === undefined && typeof legacy === 'number' && legacy > 0) {
    vad.commitMinMs = legacy
    vad.commitMaxMs = vad.commitMaxMs ?? legacy * 2
  }
  delete vad.commitWindowMs
  return vad
}

/** 深合并，只合并已知字段，忽略未知字段；并迁移旧「用 Base 变体表示克隆」配置 */
function mergeWithDefaults(saved: Partial<VoiceEngineConfig>): VoiceEngineConfig {
  const ttsSaved = { ...(saved.tts ?? {}) } as VoiceEngineConfig['tts'] & {
    qwen3Variant?: string
  }
  // 旧版：qwen3Variant 为 *-base 即表示克隆出声 → 拆到独立开关
  if (ttsSaved.qwen3CloneEnabled === undefined && isQwen3CloneVariant(ttsSaved.qwen3Variant)) {
    ttsSaved.qwen3CloneEnabled = true
    ttsSaved.qwen3CloneVariant = ttsSaved.qwen3Variant
    ttsSaved.qwen3Variant = '0.6b-custom'
  }

  return {
    asr: { ...DEFAULT_VOICE_ENGINE_CONFIG.asr, ...saved.asr },
    tts: { ...DEFAULT_VOICE_ENGINE_CONFIG.tts, ...ttsSaved },
    vad: { ...DEFAULT_VOICE_ENGINE_CONFIG.vad, ...migrateCommitWindow(saved.vad) },
    autoMuteMicWhileSpeaking: resolveAutoMute(saved),
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
