/**
 * 录屏 IPC 注册（主进程侧）
 */
import { ipcMain, type BrowserWindow } from 'electron'
import type { ScreenRecordService } from './screen-record-service'
import type { ScreenRecordStartParams, ScreenRecordStopParams, ScreenRecordNarrateParams } from '../../shared/screen-record'
import { getNarrateService } from './narrate-accessor'

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
