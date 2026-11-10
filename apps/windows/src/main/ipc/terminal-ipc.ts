/**
 * 本地终端 IPC
 *
 * 渲染层发指令，数据/退出事件由主进程推回去（带 id，多窗口不会串台）。
 * 所有 handler 都是幂等的：对已退出/已杀的 id 写数据返回 false，不抛错——
 * 用户关面板时正在拍键盘是常态，不该变成一堆报错。
 */

import { ipcMain, type BrowserWindow } from 'electron'
import {
  createTerminal,
  killAllTerminals,
  killTerminal,
  readTerminalTail,
  resizeTerminal,
  writeTerminal,
} from '../terminal/terminal-service'

type WindowGetter = () => BrowserWindow[]

export function registerTerminalIpcHandlers(getWindows: WindowGetter): void {
  /** 只推给发起的那个窗口；其他窗口不该看到别人的终端输出 */
  const push = (sender: Electron.WebContents, channel: string, payload: unknown): void => {
    if (sender.isDestroyed()) return
    sender.send(channel, payload)
  }

  ipcMain.handle(
    'terminal:create',
    (event, cwd: string, size?: { cols?: number; rows?: number }) => {
      const sender = event.sender
      const session = createTerminal(
        cwd || process.cwd(),
        (id, data) => push(sender, 'terminal:data', { id, data }),
        (id, exitCode) => push(sender, 'terminal:exit', { id, exitCode }),
      )
      if (size?.cols && size?.rows) {
        resizeTerminal(session.id, size.cols, size.rows)
      }
      return { id: session.id, tail: readTerminalTail(session.id), pid: session.pty.pid }
    },
  )

  ipcMain.handle('terminal:write', (_event, id: string, data: string) => writeTerminal(id, data))
  ipcMain.handle('terminal:resize', (_event, id: string, cols: number, rows: number) =>
    resizeTerminal(id, cols, rows),
  )
  ipcMain.handle('terminal:kill', (_event, id: string) => {
    killTerminal(id)
    return true
  })
  // getWindows 目前只在退出时用；保留参数是为了将来按窗口隔离（关窗即杀）
  void getWindows
}

/** 应用退出前统一收口：不留下孤儿 shell */
export function disposeTerminals(): void {
  killAllTerminals()
}
