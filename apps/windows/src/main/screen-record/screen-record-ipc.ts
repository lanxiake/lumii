/**
 * 录屏 IPC 注册（主进程侧）
 */
import fs from 'node:fs'
import path from 'node:path'
import { ipcMain, type BrowserWindow } from 'electron'
import type { ScreenRecordService } from './screen-record-service'
import type {
  ScreenRecordStartParams,
  ScreenRecordStopParams,
  ScreenRecordNarrateParams,
  ScreenRecordBurnSubtitlesParams,
  ScreenRecordSubtitleCue,
} from '../../shared/screen-record'
import { getNarrateService } from './narrate-accessor'
import { getBurnSubtitlesService } from './burn-accessor'
import {
  listRecordings,
  loadSubtitleProject,
  saveSubtitleProject,
  cuesToProjectCues,
} from './subtitle-project'
import { resolveRecordingsDir } from '../workspace-paths'
import { isPathUnderDir } from '../preview-path-acl'

/**
 * 注册录屏相关 ipcMain handle/on，绑定到单一 ScreenRecordService。
 */
export function registerScreenRecordIpc(
  service: ScreenRecordService,
  _mainWindow: BrowserWindow | null,
): void {
  ipcMain.handle('screen-record:list-sources', async (_e, p?: { includeThumbnail?: boolean }) => {
    return service.listSources(p?.includeThumbnail)
  })

  ipcMain.handle(
    'screen-record:start',
    async (_e, p: { params: ScreenRecordStartParams } | ScreenRecordStartParams) => {
      const params = 'params' in p && p.params ? p.params : (p as ScreenRecordStartParams)
      return service.start(params)
    },
  )

  ipcMain.handle('screen-record:stop', async (_e, p?: { params?: ScreenRecordStopParams } | ScreenRecordStopParams) => {
    const params =
      p && typeof p === 'object' && 'params' in p && p.params
        ? p.params
        : (p as ScreenRecordStopParams | undefined)
    return service.stop(params)
  })

  ipcMain.handle('screen-record:narrate', async (_e, p: { params: ScreenRecordNarrateParams }) => {
    const narrate = getNarrateService()
    if (!narrate) return { ok: false, error: 'disabled' }
    return narrate.narrate(p.params)
  })

  ipcMain.handle('screen-record:list-recordings', async () => {
    try {
      const items = listRecordings(resolveRecordingsDir())
      return { ok: true, items }
    } catch (e) {
      return {
        ok: false,
        error: 'write_failed',
        message: e instanceof Error ? e.message : String(e),
      }
    }
  })

  ipcMain.handle('screen-record:load-subtitle-project', async (_e, p: { path: string }) => {
    const videoPath = p?.path
    if (!videoPath) return { ok: false, error: 'invalid_cues', message: 'path required' }
    const abs = path.resolve(videoPath)
    const root = path.resolve(resolveRecordingsDir())
    if (!isPathUnderDir(abs, root)) {
      return { ok: false, error: 'source_not_in_recordings' }
    }
    const loaded = loadSubtitleProject(abs)
    if (!loaded.ok) {
      return { ok: false, error: loaded.error, message: loaded.message }
    }
    return { ok: true, cues: loaded.cues, source: loaded.source }
  })

  ipcMain.handle(
    'screen-record:save-subtitle-project',
    async (_e, p: { path: string; cues: ScreenRecordSubtitleCue[] }) => {
      const videoPath = p?.path
      if (!videoPath) return { ok: false, error: 'invalid_cues', message: 'path required' }
      const abs = path.resolve(videoPath)
      const root = path.resolve(resolveRecordingsDir())
      if (!isPathUnderDir(abs, root)) {
        return { ok: false, error: 'source_not_in_recordings' }
      }
      if (!fs.existsSync(abs)) {
        return { ok: false, error: 'source_unavailable' }
      }
      const cues = cuesToProjectCues(
        (p.cues ?? []).map((c) => ({
          id: c.id,
          startMs: c.startMs,
          endMs: c.endMs ?? c.startMs + 1,
          text: c.text,
          audioFile: c.audioFile,
        })),
      )
      const saved = saveSubtitleProject(abs, cues)
      if (!saved.ok) {
        return { ok: false, error: saved.error, message: saved.message }
      }
      return saved
    },
  )

  ipcMain.handle(
    'screen-record:burn-subtitles',
    async (_e, p: { params: ScreenRecordBurnSubtitlesParams }) => {
      const burn = getBurnSubtitlesService()
      if (!burn) return { ok: false, error: 'disabled' }
      return burn.burn(p.params)
    },
  )

  ipcMain.handle('screen-record:pause', async () => service.pause())

  ipcMain.handle('screen-record:resume', async () => service.resume())

  ipcMain.handle('screen-record:status', async () => service.getStatus())

  ipcMain.on(
    'screen-record:confirm-respond',
    (_e, p: { sessionId: string; allow: boolean; rememberAlwaysAllow?: boolean }) => {
      void service.respondConfirm(p)
    },
  )

  ipcMain.on(
    'screen-record:chunk',
    (
      _e,
      p: { sessionId: string; chunkBase64: string; index: number; isLast: boolean },
    ) => {
      void service.handleChunk(p)
    },
  )

  ipcMain.on('screen-record:stream-ended', (_e, p: { sessionId: string }) => {
    void service.handleStreamEnded(p)
  })

  ipcMain.on(
    'screen-record:capture-error',
    (_e, p: { sessionId: string; reason: string }) => {
      void service.handleCaptureError(p)
    },
  )
}
