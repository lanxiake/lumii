/**
 * 生产环境 ScreenRecordServiceDeps 工厂（desktopCapturer / 写盘 / 设置）
 */
import { createWriteStream as fsCreateWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { desktopCapturer } from 'electron'
import type { ScreenRecordConfig, ScreenRecordSource } from '../../shared/screen-record'
import { SCREEN_RECORD_SETTINGS_DEFAULTS } from '../../shared/screen-record'
import { resolveRecordingsDir } from '../client-data-root'
import { getFreeDiskBytes } from './disk-space'
import type { ScreenRecordServiceDeps, ScreenRecordWriteStream } from './screen-record-service'

/** 生成 recording-yyyyMMdd-HHmmss.webm 文件名（本地时区） */
export function formatRecordingFilename(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const y = now.getFullYear()
  const M = pad(now.getMonth() + 1)
  const d = pad(now.getDate())
  const h = pad(now.getHours())
  const m = pad(now.getMinutes())
  const s = pad(now.getSeconds())
  return `recording-${y}${M}${d}-${h}${m}${s}.webm`
}

/** Lumii 自身窗口标题 fallback 正则 */
const LUMII_TITLE_RE = /灵栖|Lumii/i

/**
 * 判断源是否为 Lumii 自身窗口。
 * 优先 mediaSourceId 精确匹配；否则标题 fallback。
 */
export function markIsLumii(
  source: { id: string; name: string; display_id?: string },
  lumiiMediaSourceId: string | null,
): boolean {
  if (lumiiMediaSourceId && source.id === lumiiMediaSourceId) return true
  return LUMII_TITLE_RE.test(source.name)
}

/** 真实 deps 所需回调 */
export interface CreateRealScreenRecordDepsOptions {
  /** 获取主窗口（可销毁） */
  getMainWindow: () => BrowserWindow | null
  /** 向渲染进程发事件 */
  sendToRenderer: (channel: string, payload: unknown) => void
  /** 读取渲染进程 settings JSON 字符串 */
  readSettingsJson: () => Promise<string | null>
  /** 可选：通知 renderer 持久化 alwaysAllow（主进程无法直接写 localStorage） */
  requestPersistAlwaysAllow?: (value: boolean) => void
}

/**
 * 从 settings JSON 解析 screenRecord 段（缺字段用默认值）。
 */
export function parseScreenRecordSettings(json: string | null): ScreenRecordConfig {
  if (!json) return { ...SCREEN_RECORD_SETTINGS_DEFAULTS }
  try {
    const parsed = JSON.parse(json) as { screenRecord?: Partial<ScreenRecordConfig> }
    const s = parsed.screenRecord ?? {}
    return {
      enabled: s.enabled ?? SCREEN_RECORD_SETTINGS_DEFAULTS.enabled,
      alwaysAllow: s.alwaysAllow ?? SCREEN_RECORD_SETTINGS_DEFAULTS.alwaysAllow,
      includeMicDefault: s.includeMicDefault ?? SCREEN_RECORD_SETTINGS_DEFAULTS.includeMicDefault,
      confirmTimeoutSec: s.confirmTimeoutSec ?? SCREEN_RECORD_SETTINGS_DEFAULTS.confirmTimeoutSec,
    }
  } catch {
    return { ...SCREEN_RECORD_SETTINGS_DEFAULTS }
  }
}

/**
 * 创建生产环境 ScreenRecordServiceDeps。
 */
export function createRealScreenRecordServiceDeps(
  opts: CreateRealScreenRecordDepsOptions,
): ScreenRecordServiceDeps {
  return {
    getSources: async (includeThumbnail) => {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: includeThumbnail ? { width: 320, height: 180 } : { width: 0, height: 0 },
        fetchWindowIcons: false,
      })
      let lumiiId: string | null = null
      const win = opts.getMainWindow()
      if (win && !win.isDestroyed()) {
        try {
          lumiiId = win.webContents.getMediaSourceId(win.webContents)
        } catch {
          lumiiId = null
        }
      }
      return sources.map((s): ScreenRecordSource => {
        // Electron: screen 源 id 以 screen: 开头；window 以 window: 开头
        const type: 'screen' | 'window' = s.id.startsWith('screen:') ? 'screen' : 'window'
        return {
          sourceId: s.id,
          name: s.name,
          type,
          isLumii: type === 'window' && markIsLumii(s, lumiiId),
          thumbnailDataUrl: includeThumbnail && s.thumbnail && !s.thumbnail.isEmpty()
            ? s.thumbnail.toDataURL()
            : '',
          displayId: s.display_id || undefined,
        }
      })
    },

    readSettings: async () => parseScreenRecordSettings(await opts.readSettingsJson()),

    resolveRecordingsDir,

    getFreeDiskBytes: async (dirPath) => getFreeDiskBytes(dirPath),

    notifyRendererStartCapture: (sessionId, sourceId, includeMic, maxDurationSec) => {
      opts.sendToRenderer('screen-record:event:start-capture', {
        type: 'screen-record:event:start-capture',
        sessionId,
        sourceId,
        includeMic,
        maxDurationSec,
      })
    },

    notifyRendererStopCapture: (sessionId) => {
      opts.sendToRenderer('screen-record:event:stop-capture', {
        type: 'screen-record:event:stop-capture',
        sessionId,
      })
    },

    notifyRendererCancelled: (sessionId, reason) => {
      opts.sendToRenderer('screen-record:event:cancelled', {
        type: 'screen-record:event:cancelled',
        sessionId,
        reason,
      })
    },

    notifyRendererConfirmRequested: (payload) => {
      opts.sendToRenderer('screen-record:event:confirm-requested', {
        type: 'screen-record:event:confirm-requested',
        ...payload,
      })
    },

    emitStatusChanged: (detail) => {
      opts.sendToRenderer('screen-record:event:status-changed', {
        type: 'screen-record:event:status-changed',
        status: detail.ok ? detail.status : 'error',
        detail,
      })
    },

    createWriteStream: async (): Promise<ScreenRecordWriteStream> => {
      const dir = resolveRecordingsDir()
      const filePath = path.join(dir, formatRecordingFilename())
      const stream = fsCreateWriteStream(filePath)
      let bytes = 0
      return {
        path: filePath,
        write: (buf) => {
          bytes += buf.byteLength
          stream.write(Buffer.from(buf))
        },
        end: () =>
          new Promise((resolve, reject) => {
            stream.end(() => resolve())
            stream.on('error', reject)
          }),
        bytesWritten: () => bytes,
        unlinkIfEmpty: async () => {
          if (bytes === 0) {
            try {
              await unlink(filePath)
              return true
            } catch {
              return true
            }
          }
          return false
        },
      }
    },

    nowMs: () => Date.now(),

    persistAlwaysAllow: async (value) => {
      opts.requestPersistAlwaysAllow?.(value)
    },
  }
}
