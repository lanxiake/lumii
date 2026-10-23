import { ipcMain } from 'electron'

import type { ScreenRecordStatusResult } from '../../shared/screen-record'

/**
 * 录屏扩展被禁用时，给 `screen-record:status` 注册一个「已禁用」的桩。
 *
 * 为什么需要：渲染层挂载时会无条件查一次状态。没有处理器时 Electron 抛
 * `No handler registered`，控制台刷一片红——用户看到的是「坏了」，而实际只是关掉了功能。
 * `{ ok: false, error: 'disabled' }` 是设计里就有的状态（`ScreenRecordErrorCode`），
 * UI 可以据此把入口显示为关闭。
 *
 * 只在扩展**没有**装配时调用：真实处理器由 `registerScreenRecordIpc` 注册，
 * 同一个 channel 二次 `ipcMain.handle` 会抛错。
 */
export function registerScreenRecordDisabledStub(): void {
  const result: ScreenRecordStatusResult = { ok: false, error: 'disabled' }
  ipcMain.handle('screen-record:status', async () => result)
}
