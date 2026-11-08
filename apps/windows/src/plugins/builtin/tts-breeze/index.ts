import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../../../main/kernel/events'
import { registerTtsEngine } from '../../../shared/tts-engine-registry'
import { BreezeTtsProvider } from './breeze-client.js'

/**
 * Breeze TTS 2 —— 接本地已有部署，不代为安装。
 *
 * 它是独立仓库（Linux/CUDA 为主，但也回落 CPU）的 Python 服务，本插件只做三件事：
 * 按设置里的仓库路径拉起进程、健康检查、把流式 PCM 转成 `TtsChunk`。
 *
 * **默认关闭**（`defaultEnabled: false`）：没部署 Breeze 的用户点开它只会看到
 * 一串「找不到 Python」的报错。等用户在插件页主动开启，才需要填路径。
 * 无本地模型下载，所以 `modelIds` 为空——模型面板不显示任何条目。
 */
export const ttsBreezeExtension = {
  manifest: {
    id: 'com.lumii.tts.breeze',
    name: 'Breeze TTS 2',
    version: '0.1.0',
    description: '接入本机已部署的 Breeze TTS 2（声音克隆 / 声音设计 / 风格指令）',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
    defaultEnabled: false,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.tts.breeze',
    apply(ctx) {
      ctx.effect(
        registerTtsEngine({
          id: 'breeze',
          label: 'Breeze TTS 2（本地服务，需自行部署）',
          modelIds: [],
          // 服务端是单并发（内建 _request_lock，并发请求返回 409）
          concurrency: 1,
          outputFormat: 'pcm',
          create: async (_host, cfg) =>
            new BreezeTtsProvider({
              repoPath: cfg.breezeRepoPath,
              modelDir: cfg.breezeModelDir,
              port: cfg.breezePort,
              baseUrl: cfg.breezeBaseUrl,
              python: cfg.breezePython,
              cfgScale: cfg.breezeCfgScale,
              instruction: cfg.breezeInstruction,
            }),
        }),
      )
      ctx.log.info('Breeze TTS 引擎已注册')
    },
  }),
}
