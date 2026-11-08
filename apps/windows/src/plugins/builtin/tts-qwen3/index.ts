import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../../../main/kernel/events'
import { registerTtsEngine } from '../../../shared/tts-engine-registry'
import type { VoiceTtsConfig } from '../../../shared/voice-events'
import { isQwen3CloneVariant } from '../../../shared/voice-events'
import { getQwen3SynthConcurrency, prepareQwen3TtsRuntime } from '../../../main/voice/qwen3-tts-client.js'
import { Qwen3TtsProvider } from './engine.js'

/** 所有 Qwen3 变体共用同一个 tokenizer */
const TOKENIZER_ID = 'tts-qwen3-tokenizer-12hz'

const MODEL_IDS = [
  TOKENIZER_ID,
  'tts-qwen3-0.6b-custom',
  'tts-qwen3-1.7b-custom',
  'tts-qwen3-0.6b-base',
  'tts-qwen3-1.7b-base',
  // PyTorch CUDA 运行时只服务 Qwen3 的 GPU 推理；归到这里，
  // 禁用 Qwen3 后它才不会在模型面板里残留一个 2.29GB 的无用条目。
  'runtime-pytorch-cu121',
]

/** 按配置解析应加载哪个变体的模型 id（克隆开关决定走 Base 还是 CustomVoice） */
export function qwen3ModelIdFor(tts: VoiceTtsConfig): string {
  const cloneOn = tts.qwen3CloneEnabled === true && Boolean(tts.qwen3ProfileId)
  const raw = cloneOn ? (tts.qwen3CloneVariant ?? '0.6b-base') : (tts.qwen3Variant ?? '0.6b-custom')
  const variant = !cloneOn && isQwen3CloneVariant(raw) ? '0.6b-custom' : raw
  switch (variant) {
    case '1.7b-custom':
      return 'tts-qwen3-1.7b-custom'
    case '0.6b-base':
      return 'tts-qwen3-0.6b-base'
    case '1.7b-base':
      return 'tts-qwen3-1.7b-base'
    case '0.6b-custom':
    default:
      return 'tts-qwen3-0.6b-custom'
  }
}

/**
 * Qwen3-TTS —— 本地多音色 + 声音克隆。
 *
 * 最重的一个引擎：模型 2.5–4.5GB，还要在应用管理的隔离 Python 里装 torch + qwen-tts。
 * 正因为它重，拆成独立插件才有意义——禁用后这些依赖不再被触碰。
 *
 * `concurrency` 是函数：sidecar 是进程池，池大小在运行期会变。
 */
export const ttsQwen3Extension = {
  manifest: {
    id: 'com.lumii.tts.qwen3',
    name: 'Qwen3-TTS',
    version: '0.1.0',
    description: '本地多音色合成与声音克隆（需下载 2.5–4.5GB 模型与 Python 推理依赖）',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.tts.qwen3',
    apply(ctx) {
      ctx.effect(
        registerTtsEngine({
          id: 'qwen3',
          label: 'Qwen3（本地多音色 + 声音克隆）',
          modelIds: MODEL_IDS,
          concurrency: () => getQwen3SynthConcurrency(),
          outputFormat: 'pcm',
          create: async (host, cfg) => {
            const modelId = qwen3ModelIdFor(cfg)
            if (!host.isModelReady(modelId) || !host.isModelReady(TOKENIZER_ID)) {
              throw new Error(
                'Qwen3 模型未下载，请前往「设置 → 语音」下载，或切换为 Edge TTS',
              )
            }

            const cloneOn = cfg.qwen3CloneEnabled === true && Boolean(cfg.qwen3ProfileId)
            let refAudio: string | undefined
            let refText: string | undefined
            let xVectorOnly: boolean | undefined
            let language = cfg.language ?? 'Auto'
            let mode: 'custom' | 'clone' = 'custom'

            if (cloneOn) {
              mode = 'clone'
              const profile = host.getVoiceProfile(cfg.qwen3ProfileId!)
              if (!profile) throw new Error(`克隆音色不存在: ${cfg.qwen3ProfileId}`)
              refAudio = profile.refAudioPath
              refText = profile.refText
              xVectorOnly = profile.xVectorOnly
              language = cfg.language || profile.language || 'Auto'
            }

            await prepareQwen3TtsRuntime(cfg.qwen3Device ?? 'auto')
            return new Qwen3TtsProvider(host.modelDir(modelId), host.modelDir(TOKENIZER_ID), {
              speed: cfg.speed,
              language,
              mode,
              speaker: cfg.qwen3Speaker ?? 'Vivian',
              instruct: cfg.qwen3Instruct,
              refAudio,
              refText,
              xVectorOnly,
              device: cfg.qwen3Device ?? 'auto',
            })
          },
        }),
      )
      ctx.log.info('Qwen3-TTS 引擎已注册')
    },
  }),
}
