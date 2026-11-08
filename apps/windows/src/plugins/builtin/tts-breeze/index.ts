import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../../../main/kernel/events'
import { registerTtsEngine } from '../../../shared/tts-engine-registry'
import type { VoiceTtsConfig } from '../../../shared/voice-events'
import { BreezeTtsProvider } from './breeze-client.js'

const MODEL_ID = 'tts-breeze-2'

/**
 * Breeze TTS 2 —— 与 MeloTTS / Qwen3 同一套用法：**代码内置，只下模型**。
 *
 * 推理代码随应用发版（`assets/breeze/`，来自 Apache-2.0 的上游仓库），
 * 用户只需在「设置 › 语音」下载 7.7GB 权重即可使用。
 *
 * 与 Qwen3 共用同一个托管 Python 环境（两者都需要 torch 2.9.1 + CUDA）。
 * 不装 flash-attn：它要在 Windows 上编译 CUDA 扩展，多数用户会卡在这里；
 * 上游默认的 `attn_implementation="eager"` 不需要它。
 */
export const ttsBreezeExtension = {
  manifest: {
    id: 'com.lumii.tts.breeze',
    name: 'Breeze TTS 2',
    version: '0.1.0',
    description: '高表现力中英双语合成，支持声音克隆与自然语言风格指令（需下载 7.7GB 模型）',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.tts.breeze',
    apply(ctx) {
      ctx.effect(
        registerTtsEngine({
          id: 'breeze',
          label: 'Breeze TTS 2（本地，声音克隆 + 风格指令）',
          // 模型本体 + GPU 运行时（与 Qwen3 共用同一份 torch 2.9.1）
          modelIds: [MODEL_ID, 'runtime-pytorch-cu121'],
          // 服务端内建单并发锁，并发请求直接 409
          concurrency: 1,
          outputFormat: 'pcm',
          create: async (host, cfg: VoiceTtsConfig) => {
            if (!host.isModelReady(MODEL_ID)) {
              throw new Error(
                'Breeze 模型未下载，请前往「设置 → 语音」下载后重试',
              )
            }
            return new BreezeTtsProvider({
              modelDir: host.modelDir(MODEL_ID),
              cfgScale: cfg.breezeCfgScale,
              instruction: cfg.breezeInstruction,
            })
          },
        }),
      )
      ctx.log.info('Breeze TTS 引擎已注册')
    },
  }),
}
