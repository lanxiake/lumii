/**
 * 语音通话 IPC 注册层
 * 注册 voice:command 和 voice:audio:chunk 两个 IPC 通道
 */
import { ipcMain, type BrowserWindow } from 'electron'
import { type VoiceCallService } from './voice-service.js'
import { type VoiceModelManager, PYTORCH_CUDA_RUNTIME_ID } from './model-manager.js'
import { AsrTestSession } from './asr-test-session.js'
import type { VoiceCommand } from '../../shared/voice-commands.js'
import { saveVoiceEngineConfig } from './voice-config-store.js'
import { prepareQwen3TtsRuntime, invalidateQwen3TtsPrepare, resetSharedQwen3TtsClient } from './qwen3-tts-client.js'

const log = {
  info: (...args: unknown[]) => console.log('[VoiceIPC]', ...args),
  debug: (...args: unknown[]) => console.log('[VoiceIPC:DEBUG]', ...args),
  warn: (...args: unknown[]) => console.warn('[VoiceIPC]', ...args),
  error: (...args: unknown[]) => console.error('[VoiceIPC]', ...args),
}

let voiceIpcInstalled = false

/**
 * 若已下载任意 Qwen3 TTS 权重，后台预装 qwen-tts（不阻塞 UI）
 */
function maybePrepareQwen3Runtime(
  modelManager: VoiceModelManager,
  voiceService: VoiceCallService,
  reason: string,
): void {
  const hasQwenModel =
    modelManager.isModelDownloaded('tts-qwen3-0.6b-custom') ||
    modelManager.isModelDownloaded('tts-qwen3-1.7b-custom') ||
    modelManager.isModelDownloaded('tts-qwen3-0.6b-base') ||
    modelManager.isModelDownloaded('tts-qwen3-1.7b-base')
  if (!hasQwenModel) return
  const devicePref = voiceService.getConfig().tts.qwen3Device ?? 'auto'
  log.info(`[prepareQwen3] 触发预装 reason=${reason} device=${devicePref}`)
  void prepareQwen3TtsRuntime(devicePref).catch((e) => {
    log.warn(`[prepareQwen3] 预装失败: ${(e as Error).message}`)
  })
}

/**
 * 注册语音相关 IPC（命令 / 音频帧 / 模型下载 / ASR 测试）
 */
export function registerVoiceIpc(
  win: BrowserWindow,
  voiceService: VoiceCallService,
  modelManager: VoiceModelManager,
): void {
  if (voiceIpcInstalled) {
    log.info('voice IPC 已注册，跳过重复 install')
    return
  }
  voiceIpcInstalled = true

  const asrTest = new AsrTestSession(modelManager, () => voiceService.getConfig())

  // 启动时若模型已在本地，提前装依赖，避免首次预览卡住
  maybePrepareQwen3Runtime(modelManager, voiceService, 'ipc-register')
  if (voiceService.getConfig().tts.provider === 'qwen3') {
    maybePrepareQwen3Runtime(modelManager, voiceService, 'config-qwen3')
  }

  /**
   * 推送模型进度事件
   */
  const sendModelProgress = (
    modelId: string,
    progress: {
      progress: number
      downloadedBytes: number
      totalBytes: number
      state: string
      bytesPerSecond?: number
    },
  ) => {
    if (win.isDestroyed()) return
    try {
      win.webContents.send('voice:event', {
        type: 'voice:models:progress',
        modelId,
        progress: progress.progress,
        bytesDownloaded: progress.downloadedBytes,
        totalBytes: progress.totalBytes,
        state: progress.state,
        bytesPerSecond: progress.bytesPerSecond,
      })
      if (progress.state === 'ready' || progress.state === 'paused' || progress.progress >= 1) {
        win.webContents.send('voice:event', {
          type: 'voice:models:status',
          models: modelManager.getModelsStatus(),
        })
      }
    } catch (e) {
      log.error(`[voice:models] IPC 发送失败: ${(e as Error).message}`)
    }
  }

  // ── 命令通道（invoke 模式，有响应）─────────────────────────────────────
  ipcMain.handle('voice:command', async (_event, command: VoiceCommand) => {
    log.debug(`[voice:command] type=${command.type}`)

    try {
      switch (command.type) {
        case 'voice:call:start': {
          const micless = (command as { micless?: boolean }).micless === true
          const cfg = voiceService.getConfig().tts
          const ttsProvider = cfg.provider
          const variant = voiceService.resolveActiveQwen3Variant()
          if (micless) {
            if (!modelManager.isTtsReady(ttsProvider, variant)) {
              return {
                error: 'models_not_ready',
                models: modelManager.getModelsStatus(),
              }
            }
          } else if (!modelManager.areRequiredModelsReady(ttsProvider, variant)) {
            return {
              error: 'models_not_ready',
              models: modelManager.getModelsStatus(),
            }
          }
          return {
            callId: await voiceService.startCall(command.sessionKey, command.agentId, { micless }),
          }
        }

        case 'voice:call:stop':
          await voiceService.stopCall()
          return { ok: true }

        case 'voice:models:get':
          return modelManager.getModelsStatus()

        case 'voice:models:download':
          modelManager.startDownload(
            command.modelId,
            (progress) => {
              sendModelProgress(command.modelId, progress)
              if (progress.state !== 'ready') return
              // Qwen3 权重下完后立刻后台预装 pip 依赖
              if (
                String(command.modelId).startsWith('tts-qwen3-') &&
                !String(command.modelId).includes('tokenizer')
              ) {
                maybePrepareQwen3Runtime(modelManager, voiceService, `download-ready:${command.modelId}`)
              }
              // CUDA 运行时安装完成后，按当前设备偏好重新准备
              if (command.modelId === PYTORCH_CUDA_RUNTIME_ID) {
                invalidateQwen3TtsPrepare()
                void resetSharedQwen3TtsClient().catch(() => undefined)
                maybePrepareQwen3Runtime(modelManager, voiceService, 'cuda-runtime-ready')
              }
            },
            (message) => {
              if (!win.isDestroyed()) {
                win.webContents.send('voice:event', {
                  type: 'voice:models:error',
                  modelId: command.modelId,
                  message,
                })
                win.webContents.send('voice:event', {
                  type: 'voice:models:status',
                  models: modelManager.getModelsStatus(),
                })
              }
            },
          )
          return { ok: true }

        case 'voice:models:pause':
          return { ok: modelManager.pauseDownload(command.modelId) }

        case 'voice:models:cancel':
          return { ok: modelManager.cancelDownload(command.modelId) }

        case 'voice:config:get':
          return voiceService.getConfig()

        case 'voice:config:set': {
          const prevDevice = voiceService.getConfig().tts.qwen3Device ?? 'auto'
          await voiceService.setConfig(command.config as any)
          await saveVoiceEngineConfig(voiceService.getConfig())
          const nextDevice = voiceService.getConfig().tts.qwen3Device ?? 'auto'
          if (prevDevice !== nextDevice) {
            invalidateQwen3TtsPrepare()
            void resetSharedQwen3TtsClient().catch(() => undefined)
            log.info(`[voice:config:set] 设备偏好变更 ${prevDevice} → ${nextDevice}，将重装 PyTorch`)
            // 选 GPU / 自动且未下载 CUDA 运行时时，自动开始可断点续传的下载
            if (
              (nextDevice === 'cuda' || nextDevice === 'auto') &&
              !modelManager.isModelDownloaded(PYTORCH_CUDA_RUNTIME_ID)
            ) {
              log.info('[voice:config:set] 自动开始下载 PyTorch CUDA 运行时')
              modelManager.startDownload(
                PYTORCH_CUDA_RUNTIME_ID,
                (progress) => {
                  sendModelProgress(PYTORCH_CUDA_RUNTIME_ID, progress)
                  if (progress.state === 'ready') {
                    invalidateQwen3TtsPrepare()
                    void resetSharedQwen3TtsClient().catch(() => undefined)
                    maybePrepareQwen3Runtime(modelManager, voiceService, 'cuda-runtime-ready')
                  }
                },
                (message) => {
                  if (!win.isDestroyed()) {
                    win.webContents.send('voice:event', {
                      type: 'voice:models:error',
                      modelId: PYTORCH_CUDA_RUNTIME_ID,
                      message,
                    })
                  }
                },
              )
            }
          }
          if (!win.isDestroyed()) {
            try {
              win.webContents.send('voice:event', {
                type: 'voice:config:updated',
                config: voiceService.getConfig(),
              })
            } catch (e) {
              log.warn(`[voice:config:set] 推送 config:updated 失败: ${(e as Error).message}`)
            }
          }
          if (voiceService.getConfig().tts.provider === 'qwen3') {
            maybePrepareQwen3Runtime(modelManager, voiceService, 'config-set-qwen3')
          }
          return { ok: true }
        }

        case 'voice:playback:finished':
          voiceService.onPlaybackFinished()
          return { ok: true }

        case 'voice:tts:preview': {
          const cfg = voiceService.getConfig().tts
          const activeVariant = voiceService.resolveActiveQwen3Variant()
          if (!modelManager.isTtsReady(cfg.provider, activeVariant)) {
            const models = modelManager.getModelsStatus()
            if (!win.isDestroyed()) {
              try {
                win.webContents.send('voice:event', {
                  type: 'voice:models:status',
                  models,
                })
              } catch (e) {
                log.warn(`[voice:tts:preview] 推送 models:status 失败: ${(e as Error).message}`)
              }
            }
            return { error: 'models_not_ready', models }
          }
          if (
            cfg.provider === 'qwen3' &&
            cfg.qwen3CloneEnabled === true &&
            !cfg.qwen3ProfileId
          ) {
            return {
              error: 'profile_required',
              message: '已开启声音克隆，请先创建并选择音色档案',
            }
          }
          const raw = (command.text ?? '你好，这是声音预览。').trim()
          // 设置页试听默认 100；消息朗读等应显式传入更大 maxChars，避免后半段被静默截断
          const maxChars = Math.max(
            1,
            Math.min(typeof command.maxChars === 'number' ? command.maxChars : 100, 20_000),
          )
          const previewText = raw.slice(0, maxChars) || '你好，这是声音预览。'
          if (raw.length > maxChars) {
            log.warn(
              `[voice:tts:preview] 文本 ${raw.length} 字已截断为 ${maxChars} 字（请提高 maxChars 以朗读全文）`,
            )
          }
          void voiceService.previewTts(previewText, win)
          return { ok: true }
        }

        case 'voice:tts:stop-preview':
          voiceService.stopPreview()
          return { ok: true }

        case 'voice:tts:generate-file': {
          const { text, destDir } = command as any
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const os = require('node:os')
          const resolvedDir = destDir || os.tmpdir()
          const filePath = await voiceService.generateAudioFile(text, resolvedDir)
          return { ok: true, filePath }
        }

        case 'voice:asr:test:start':
          return await asrTest.start(win)

        case 'voice:asr:test:stop':
          await asrTest.stop()
          return { ok: true }

        case 'voice:profiles:list':
          return voiceService.getProfileStore().list()

        case 'voice:profiles:upsert': {
          const profile = voiceService.getProfileStore().upsert(command.profile)
          return { ok: true, profile }
        }

        case 'voice:profiles:delete':
          return { ok: voiceService.getProfileStore().delete(command.profileId) }

        default:
          log.warn(`[voice:command] 未知命令: ${(command as any).type}`)
          return { error: 'unknown_command' }
      }
    } catch (e) {
      log.error(`[voice:command] 处理失败: ${(e as Error).message}`)
      return { error: (e as Error).message }
    }
  })

  // ── 音频帧通道（send 模式，单向高频，不需要响应）──────────────────────
  let lastAudioErrorMsg = ''
  let audioErrorRepeatCount = 0

  ipcMain.on('voice:audio:chunk', (_event, callId: string, buffer: Buffer) => {
    const samples = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)

    // ASR 测试会话优先消费音频
    if (asrTest.isActive() && asrTest.getCallId() === callId) {
      try {
        asrTest.handleAudioChunk(samples)
      } catch (e) {
        log.error(`[voice:audio:chunk] ASR 测试失败: ${(e as Error).message}`)
      }
      return
    }

    voiceService.handleAudioChunk(samples).catch((e: Error) => {
      const msg = e.message
      if (msg !== lastAudioErrorMsg) {
        lastAudioErrorMsg = msg
        audioErrorRepeatCount = 1
        log.error(`[voice:audio:chunk] 处理失败: ${msg}`)
        if (!win.isDestroyed()) {
          try {
            win.webContents.send('voice:event', {
              type: 'voice:error',
              callId,
              code: 'unknown',
              message: msg,
            })
          } catch (err) {
            log.error(`[voice:audio:chunk] IPC 发送失败: ${(err as Error).message}`)
          }
        }
      } else {
        audioErrorRepeatCount++
        if (audioErrorRepeatCount % 100 === 0) {
          log.warn(`[voice:audio:chunk] 同一错误已重复 ${audioErrorRepeatCount} 次: ${msg}`)
        }
      }
    })
  })

  log.info('[registerVoiceIpc] 语音 IPC 注册完成')
}
