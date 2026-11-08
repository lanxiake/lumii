import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../../../main/kernel/events'
import { registerTtsEngine } from '../../../shared/tts-engine-registry'
import { EdgeTtsProvider } from './engine.js'

/**
 * Edge TTS —— **内置默认的合成引擎**。
 *
 * 不下载模型、不依赖 Python、不碰 GPU：只要联网就永远可用。所以其他引擎全部被
 * 禁用时，voice 插件仍能回落到它出声（见 voice-service 的 provider 回落逻辑）。
 *
 * `concurrency: 3`：msedge-tts 每次合成开一条独立 WS 流，3 路句级并行是实测稳的上限。
 */
export const ttsEdgeExtension = {
  manifest: {
    id: 'com.lumii.tts.edge',
    name: 'Edge TTS',
    version: '0.1.0',
    description: '在线语音合成（微软 Edge 朗读），免下载、开箱即用；断网不可用',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.tts.edge',
    apply(ctx) {
      ctx.effect(
        registerTtsEngine({
          id: 'edge',
          label: 'Edge TTS（联网，免下载）',
          modelIds: [],
          concurrency: 3,
          outputFormat: 'mp3',
          create: async (_host, cfg) => {
            const p = new EdgeTtsProvider(cfg.voice ?? 'zh-CN-XiaoxiaoNeural', cfg.speed ?? 1.2)
            await p.initialize()
            return p
          },
        }),
      )
      ctx.log.info('Edge TTS 引擎已注册')
    },
  }),
}
