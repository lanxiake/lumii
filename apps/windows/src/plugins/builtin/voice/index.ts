import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../../../main/kernel/events'
import { isSherpaLoaded, onnxGateState } from '../../../main/onnx-runtime-gate'
import { S } from '../../../main/kernel/services'
import { submitVoiceTranscript } from '../../../main/ipc/agent-runtime-ipc.js'
import { setChannelAsrReadyChecker } from '../../../main/channel/channel-voice-asr-hint.js'
import { setAudioTranscribeCallback } from '../../../main/agent-runtime'
import { VoiceCallService } from './voice-service.js'
import { VoiceModelManager } from './model-manager.js'
import { registerVoiceIpc } from './voice-ipc.js'
import { loadVoiceEngineConfig } from './voice-config-store.js'

/**
 * 语音扩展（ASR / TTS / 来电）。
 *
 * ## 为什么它**不能**懒激活（与其它扩展的关键区别）
 *
 * `onnx-runtime-gate` 的顺序约束：进程里有两份同名 `onnxruntime.dll`（sherpa 1.27 /
 * onnxruntime-node 1.14），Windows 按基名解析。VAD 必须**先于** E5 模型加载，
 * 否则原生层直接崩（Exit 4294930435）。
 *
 * 闸门状态机是 `idle →(sherpaFirst)→ holding →(sherpaDone)→ done`，而
 * `waitForSherpa()` 只在 `holding` 时挂起；本扩展被**禁用**时闸门停在 `idle`，
 * E5 会直接进入不可逆的 `e5Running`，此后 `sherpaFirst()` 被拒绝。
 *
 * 因此：**禁用语音 → 本进程不再可能启用语音，恢复需要重启**。这是既有约束，
 * 不是本次选择；UI 若要提供开关，必须如实提示「需重启」。
 *
 * ## 时序
 *
 * 装配等 `app:window-ready`（`VoiceCallService` 构造需要主窗口），
 * 而窗口在 S2–S5 创建、bridge 在 S7 初始化 —— 天然满足「VAD 先于 E5」。
 */
export const voiceExtension = {
  manifest: {
    id: 'com.lumii.voice',
    name: '语音',
    version: '0.1.0',
    description: '语音识别、语音合成与语音通话',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.voice',
    provides: ['voice'],
    async apply(ctx) {
      let started = false

      const setup = async (): Promise<void> => {
        if (started) return
        const win = ctx.get(S.mainWindow)?.get() ?? null
        if (!win) return

        // ONNX 运行时是进程级、不可逆的：E5（onnxruntime 1.14）一旦跑过，
        // 再加载 sherpa（1.27）会在原生层崩（见 onnx-runtime-gate.ts）。
        // 所以「启动时被禁用、运行期想启用」这条路上，晚于 E5 的启用必须拒绝，
        // 让设置页如实显示「需要重启」——而不是让用户点开就崩。
        // 判据是「这个进程绑的是谁」：sherpa 加载过就安全（重新加载同一份 1.27）；
        // 没加载过而 E5 已经跑过，再加载 sherpa 会崩——那种情况只能重启。
        if (!isSherpaLoaded() && onnxGateState().phase === 'e5Running') {
          throw new Error('ONNX 运行时已被 E5 占用，启用语音需要重启应用')
        }

        started = true

        const modelManager = new VoiceModelManager()
        const config = await loadVoiceEngineConfig()
        const service = new VoiceCallService(
          win,
          (sessionKey, content, audioWavBase64) => submitVoiceTranscript(sessionKey, content, audioWavBase64),
          modelManager,
          config,
        )

        registerVoiceIpc(
          win,
          service,
          modelManager,
          ctx.get(S.perf) ?? undefined,
          {
            handle: (channel, listener) => ctx.registerIpc?.(channel, listener),
            on: (channel, listener) => ctx.registerIpcListener?.(channel, listener),
          },
        )

        // 停用：释放引擎（VAD/ASR/TTS 原生实例）并把两条全局回调复位，
        // 否则渠道 ASR 与文件导入会继续把活派给一个已释放的服务。
        ctx.effect(() => {
          setChannelAsrReadyChecker(() => false)
          setAudioTranscribeCallback(null)
          void service.dispose().catch((e: Error) => ctx.log.warn(`语音释放失败: ${e.message}`))
          ctx.log.info('语音插件卸载，引擎已释放')
        })

        // 渠道语音失败提示：按 Paraformer 是否已下载分流文案
        setChannelAsrReadyChecker(() => modelManager.isModelDownloaded('asr-paraformer-zh'))
        // 音频 ASR 能力注入文件导入 IPC（闭包在调用时解析最新实例）
        setAudioTranscribeCallback((base64, mimeType) => service.transcribeAudioBuffer(base64, mimeType))

        ctx.provide(S.voice, service)
        ctx.log.info('语音通话服务已注册')

        // VAD 预热：必须在 bridge 初始化（E5）之前开始占住 ONNX 运行时。
        // 不阻塞启动；失败只记日志——VAD 不可用不该拦住对话。
        void service
          .ensureInitialized()
          .then(() => ctx.log.info('语音引擎预热完成（VAD 已占 ONNX 运行时）'))
          .catch((e: Error) => ctx.log.warn(`语音引擎预热失败（非致命）: ${e.message}`))
      }

      if (ctx.get(S.mainWindow)?.get()) {
        // 运行期重新启用：**等装配完成**，失败要让 activate 如实报错（不吞成 unhandled rejection）
        await setup()
      } else {
        // 事件监听器签名是同步的，这里显式兜住异步装配的异常，避免变成未处理 rejection
        ctx.on('app:window-ready', () => {
          void setup().catch((e: Error) => ctx.log.error(`语音装配失败: ${e.message}`))
        })
      }
    },
  }),
}
