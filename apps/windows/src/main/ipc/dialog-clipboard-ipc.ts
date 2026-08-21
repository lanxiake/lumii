/**
 * 对话框和剪贴板相关 IPC handlers
 */
import { ipcMain, dialog, clipboard, type BrowserWindow } from 'electron'
import { promisify } from 'util'
import { execFile as _execFile } from 'child_process'
import { existsSync } from 'fs'

const _execFileAsync = promisify(_execFile)

interface DialogClipboardIpcDeps {
  getMainWindow: () => BrowserWindow | null
}

let deps: DialogClipboardIpcDeps | null = null

export function setDialogClipboardIpcDeps(d: DialogClipboardIpcDeps): void {
  deps = d
}

export function registerDialogClipboardIpcHandlers(): void {
  if (!deps) throw new Error('DialogClipboardIpc deps not set')

  // === 对话框 ===
  ipcMain.handle('dialog:showOpenDialog', async (_event, options: Electron.OpenDialogOptions) => {
    const mainWindow = deps!.getMainWindow()
    if (!mainWindow) throw new Error('Main window not available')
    return dialog.showOpenDialog(mainWindow, options)
  })

  ipcMain.handle('dialog:showSaveDialog', async (_event, options: Electron.SaveDialogOptions) => {
    const mainWindow = deps!.getMainWindow()
    if (!mainWindow) throw new Error('Main window not available')
    return dialog.showSaveDialog(mainWindow, options)
  })

  ipcMain.handle('dialog:showMessageBox', async (_event, options: Electron.MessageBoxOptions) => {
    const mainWindow = deps!.getMainWindow()
    if (!mainWindow) throw new Error('Main window not available')
    return dialog.showMessageBox(mainWindow, options)
  })

  // === 剪贴板 ===
  ipcMain.handle('clipboard:readText', () => {
    return clipboard.readText()
  })

  ipcMain.handle('clipboard:writeText', (_event, text: string) => {
    if (typeof text !== 'string') {
      throw new Error('文本必须是字符串')
    }
    // 限制剪贴板写入大小
    if (text.length > 10 * 1024 * 1024) {
      throw new Error('文本超出大小限制 (10MB)')
    }
    clipboard.writeText(text)
  })

  /**
   * 将文件对象（而非路径文本）写入系统剪贴板，可在资源管理器/聊天框直接粘贴出文件。
   * Electron 的 clipboard 不直接支持 Windows 的 CF_HDROP，故用 PowerShell Set-Clipboard -LiteralPath。
   * 路径通过 execFile 参数数组传入（非拼接命令行），避免命令注入。
   */
  ipcMain.handle('clipboard:writeFiles', async (_event, filePaths: string[]) => {
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      throw new Error('文件路径列表不能为空')
    }
    const paths = filePaths.filter((p): p is string => typeof p === 'string' && p.length > 0)
    if (paths.length === 0) {
      throw new Error('文件路径列表不能为空')
    }
    // 校验文件均存在，避免把无效路径写进剪贴板
    for (const p of paths) {
      if (!existsSync(p)) {
        throw new Error(`文件不存在: ${p}`)
      }
    }
    if (process.platform === 'win32') {
      // -LiteralPath 接收数组：逐个作为独立参数传入，PowerShell 不做通配符/转义解释
      await _execFileAsync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard', '-LiteralPath', ...paths],
        { timeout: 15000, windowsHide: true },
      )
      return
    }
    if (process.platform === 'darwin') {
      const fileList = paths.map((p) => `POSIX file "${p.replace(/"/g, '\\"')}"`).join(', ')
      await _execFileAsync(
        'osascript',
        ['-e', `set the clipboard to {${fileList}}`],
        { timeout: 15000 },
      )
      return
    }
    // 其余平台无统一的文件剪贴板机制，退化为写入路径文本
    clipboard.writeText(paths.join('\n'))
  })
}
