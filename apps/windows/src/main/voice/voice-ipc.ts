/**
 * 语音通话 IPC 注册层
 * 注册 voice:command 和 voice:audio:chunk 两个 IPC 通道
 */
import { ipcMain, type BrowserWindow } from 'electron'
import { type VoiceCallService } from './voice-service.js'
import { type VoiceModelManager } from './model-manager.js'
import type { VoiceCommand } from '../../shared/voice-commands.js'
import { saveVoiceEngineConfig } from './voice-config-store.js'

const log = {
  info: (...args: unknown[]) => console.log('[VoiceIPC]', ...args),
  debug: (...args: unknown[]) => console.log('[VoiceIPC:DEBUG]', ...args),
  warn: (...args: unknown[]) => console.warn('[VoiceIPC]', ...args),
  error: (...args: unknown[]) => console.error('[VoiceIPC]', ...args),
}

let voiceIpcInstalled = false

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
          } else if (!modelManager.areRequiredModelsReady()) {
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
              if (!win.isDestroyed()) {
                try {
                  win.webContents.send('voice:event', {
                    type: 'voice:models:progress',
                    modelId: command.modelId,
                    progress: progress.progress,
                    bytesDownloaded: progress.downloadedBytes,
                    totalBytes: progress.totalBytes,
                  })
                  if (progress.progress >= 1) {
                    win.webContents.send('voice:event', {
                      type: 'voice:models:status',
                      models: modelManager.getModelsStatus(),
                    })
                  }
                } catch (e) {
                  log.error(`[voice:models:download] IPC 发送失败: ${(e as Error).message}`)
                }
              }
            },
            (message) => {
              if (!win.isDestroyed()) {
                win.webContents.send('voice:event', {
                  type: 'voice:models:error',
                  modelId: command.modelId,
                  message,
                })
              }
            },
          )
          return { ok: true }

        case 'voice:config:get':
          return voiceService.getConfig()

        case 'voice:config:set':
          await voiceService.setConfig(command.config as any)
          // 持久化到磁盘，确保重启后配置不丢失
          await saveVoiceEngineConfig(voiceService.getConfig())
          // 推送配置更新事件，渲染进程可热更新音量等渲染侧状态
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

    voiceService.handleAudioChunk(samples).catch((e: Error) => {
      const msg = e.message
      if (msg !== lastAudioErrorMsg) {
        // 新错误：记录 + 通知渲染进程
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
          } catch (e) {
            log.error(`[voice:audio:chunk] IPC 发送失败: ${(e as Error).message}`)
          }
        }
      } else {
        // 重复错误：每 100 次打印一次，不推送重复事件
        audioErrorRepeatCount++
        if (audioErrorRepeatCount % 100 === 0) {
          log.warn(`[voice:audio:chunk] 同一错误已重复 ${audioErrorRepeatCount} 次: ${msg}`)
        }
      }
    })
  })

  log.info('[registerVoiceIpc] 语音 IPC 注册完成')
}
