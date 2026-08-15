/**
 * 录屏 IPC 注册（主进程侧）
 */
import { ipcMain, type BrowserWindow } from 'electron'
import type { ScreenRecordService } from './screen-record-service'
import type { ScreenRecordStartParams } from '../../shared/screen-record'

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

  ipcMain.handle('screen-record:stop', async () => service.stop())

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
