/**
 * 语音通话 IPC 注册层
 * 注册 voice:command 和 voice:audio:chunk 两个 IPC 通道
 */
import { ipcMain, type BrowserWindow } from 'electron'
import { type VoiceCallService } from './voice-service.js'
import { type VoiceModelManager } from './model-manager.js'
import { AsrTestSession } from './asr-test-session.js'
import type { VoiceCommand } from '../../shared/voice-commands.js'
import { saveVoiceEngineConfig } from './voice-config-store.js'

const log = {
  info: (...args: unknown[]) => console.log('[VoiceIPC]', ...args),
  debug: (...args: unknown[]) => console.log('[VoiceIPC:DEBUG]', ...args),
  warn: (...args: unknown[]) => console.warn('[VoiceIPC]', ...args),
  error: (...args: unknown[]) => console.error('[VoiceIPC]', ...args),
}

let voiceIpcInstalled = false

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

  /**
   * 推送模型进度事件
   */
  const sendModelProgress = (
    modelId: string,
    progress: { progress: number; downloadedBytes: number; totalBytes: number; state: string },
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
      })
      if (progress.state === 'ready' || progress.progress >= 1) {
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
          const ttsProvider = voiceService.getConfig().tts.provider
          if (micless) {
            if (!modelManager.isTtsReady(ttsProvider)) {
              return {
                error: 'models_not_ready',
                models: modelManager.getModelsStatus(),
              }
            }
          } else if (!modelManager.areRequiredModelsReady(ttsProvider)) {
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
            (progress) => sendModelProgress(command.modelId, progress),
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

        case 'voice:config:set':
          await voiceService.setConfig(command.config as any)
          await saveVoiceEngineConfig(voiceService.getConfig())
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
          return { ok: true }

        case 'voice:playback:finished':
          voiceService.onPlaybackFinished()
          return { ok: true }

        case 'voice:tts:preview': {
          const ttsProvider = voiceService.getConfig().tts.provider
          if (!modelManager.isTtsReady(ttsProvider)) {
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
          const previewText = command.text ?? '你好，这是声音预览。'
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
