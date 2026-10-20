import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../kernel/events'
import { S } from '../kernel/services'
import {
  createScreenRecordService,
  createRealScreenRecordServiceDeps,
  parseScreenRecordSettings,
  registerScreenRecordIpc,
} from '../screen-record'
import { setScreenRecordService } from '../screen-record/accessor'
import { createNarrateService } from '../screen-record/narrate-service'
import { setNarrateService } from '../screen-record/narrate-accessor'
import { createBurnSubtitlesService } from '../screen-record/burn-subtitles-service'
import { setBurnSubtitlesService } from '../screen-record/burn-accessor'
import { resolveRecordingsDir } from '../workspace-paths'

/**
 * 录屏扩展。
 *
 * 两个时序约束（都是既有代码的要求，不是这里新加的）：
 * 1. **必须在主窗口创建之后**才能装配：窗口捕获、设置读取、IPC 注册都依赖它。
 *    所以这里不直接干活，而是等 `app:window-ready`；
 * 2. 旁白/烧录与录屏 IPC **同步挂接**，否则启动窗口期 invoke 会拿到 disabled。
 *
 * 禁用本扩展时：无录屏服务、无 `screen-record:*` IPC，主窗口一切正常。
 */
export const screenRecordExtension = {
  manifest: {
    id: 'com.lumii.screen-record',
    name: '录屏',
    version: '0.1.0',
    description: '窗口/屏幕录制、旁白配音与字幕烧录',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.screen-record',
    provides: ['screenRecord'],
    apply(ctx) {
      let started = false

      const setup = (): void => {
        if (started) return
        // 服务容器里一定有 mainWindow getter（宿主在启动时注入），缺了就退回「永远 null」
        const mainWindowRef = ctx.get(S.mainWindow)
        const getMainWindow = () => mainWindowRef?.get() ?? null
        const win = getMainWindow()
        // 无头模式下没有窗口：录屏没有意义，保持未装配（与原先跳过初始化一致）
        if (!win) return
        started = true

        const deps = createRealScreenRecordServiceDeps({
          getMainWindow,
          sendToRenderer: (channel, payload) => {
            const w = getMainWindow()
            if (w && !w.isDestroyed()) w.webContents.send(channel, payload)
          },
          readSettingsJson: async () => {
            const w = getMainWindow()
            if (!w || w.isDestroyed()) return null
            try {
              return await w.webContents.executeJavaScript(
                `localStorage.getItem('mtbot-assistant-settings')`,
              )
            } catch {
              return null
            }
          },
          requestPersistAlwaysAllow: (value) => {
            const w = getMainWindow()
            if (w && !w.isDestroyed()) w.webContents.send('screen-record:persist-always-allow', value)
          },
        })

        // 录制状态同步到托盘：托盘不在（无头）时静默跳过
        const origEmit = deps.emitStatusChanged
        deps.emitStatusChanged = (detail) => {
          origEmit(detail)
          const tray = ctx.get(S.tray)?.get()
          if (detail.ok) {
            tray?.updateScreenRecordState(
              detail.status === 'recording',
              detail.elapsedMs ?? 0,
              detail.status === 'paused',
            )
          } else {
            tray?.updateScreenRecordState(false, 0, false)
          }
        }

        const service = createScreenRecordService(deps)
        setScreenRecordService(service)
        registerScreenRecordIpc(service, win, ctx.get(S.perf) ?? undefined)

        // 旁白/烧录挂接：TTS 闭包惰性读语音服务，未就绪时返回明确的 tts_unavailable
        const mediaDeps = {
          resolveRecordingsDir,
          readSettings: async () => {
            const w = getMainWindow()
            let json: string | null = null
            if (w && !w.isDestroyed()) {
              try {
                json = await w.webContents.executeJavaScript(
                  `localStorage.getItem('mtbot-assistant-settings')`,
                )
              } catch {
                json = null
              }
            }
            return parseScreenRecordSettings(json)
          },
          generateAudioFile: async (text: string, destDir: string) => {
            const voice = ctx.get(S.voice)
            if (!voice) throw new Error('语音服务未初始化，请稍后再试')
            return voice.generateAudioFile(text, destDir)
          },
        }
        setNarrateService(createNarrateService(mediaDeps))
        setBurnSubtitlesService(createBurnSubtitlesService(mediaDeps))

        ctx.effect(() => {
          // 退出/卸载时把进行中的录制收尾，避免留下坏文件
          void service.flushBeforeQuit().catch(() => undefined)
        })

        ctx.provide(S.screenRecord, service)
        ctx.log.info('录屏服务已装配')
      }

      // 窗口可能已经就绪（理论上不会：扩展在 S1 激活，窗口在 S2–S5 创建）
      ctx.get(S.mainWindow)?.get() ? setup() : ctx.on('app:window-ready', setup)
    },
  }),
}
