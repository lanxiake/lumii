import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../../../main/kernel/events'
import { registerTtsEngine } from '../../../shared/tts-engine-registry'
import { MeloTtsProvider } from './engine.js'

const MODEL_ID = 'tts-melo-zh-en'

/**
 * MeloTTS —— 本地离线合成，sherpa-onnx 跑 ONNX，不依赖 Python。
 *
 * 模型（约 180MB）通过 voice 插件的模型管理器按需下载；插件被禁用时，
 * 这个模型 id 不再出现在「模型」面板里（模型列表按已注册引擎过滤）。
 *
 * `concurrency: 1`：单个 sherpa OfflineTts 实例内部串行，并行调用只会排队。
 */
export const ttsMeloExtension = {
  manifest: {
    id: 'com.lumii.tts.melo',
    name: 'MeloTTS',
    version: '0.1.0',
    description: '本地离线语音合成（中英混读，单音色），需下载约 180MB 模型',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.tts.melo',
    apply(ctx) {
      ctx.effect(
        registerTtsEngine({
          id: 'local-vits',
          label: '本地 MeloTTS 中英混读（离线）',
          modelIds: [MODEL_ID],
          concurrency: 1,
          outputFormat: 'pcm',
          create: async (host, cfg) => {
            if (!host.isModelReady(MODEL_ID)) {
              throw new Error(
                'MeloTTS 模型未下载，请前往「设置 → 语音」下载，或切换为 Edge TTS',
              )
            }
            return new MeloTtsProvider(host.modelDir(MODEL_ID), 0, cfg.speed ?? 1.0)
          },
        }),
      )
      ctx.log.info('MeloTTS 引擎已注册')
    },
  }),
}
