/**
 * 插件中心 · 通用安装骨架
 *
 * 每个插件 = 一个 `PluginHandler`（查状态 / 安装 / 卸载）。本模块只负责「按 id 分发」：
 * - IPC：`plugin:list` / `plugin:install` / `plugin:cancel` / `plugin:uninstall`
 * - 统一进度通道 `plugin:progress`（载荷带 `id`）
 * - 每插件独立的 AbortController（取消只影响该插件）
 *
 * **具体下载逻辑不在这里**：CloakBrowser 有自己的「GitHub Releases + 镜像测速」下载器，
 * 后续 ffmpeg 等会走一个共享的「下载到 target」实现。骨架只要求它们实现同一个接口。
 */
import { ipcMain } from 'electron'

/** 下载进度（各 handler 复用同一形状，渲染层据此渲染进度条） */
export type PluginProgress = {
  phase: 'checking' | 'downloading' | 'extracting' | 'done' | 'skipped' | 'error' | 'cancelled'
  percent?: number
  downloadedBytes?: number
  totalBytes?: number
  version?: string
  error?: string
  mirror?: string
}

/** 已安装状态（`installed:false` 时其余字段无意义） */
export type PluginInstalledStatus = {
  installed: boolean
  version?: string
  /** 随包/当前可用的最新版本；安装了旧版时 UI 据此显示「可更新」 */
  latestVersion?: string
  exePath?: string
}

export interface PluginHandler {
  id: string
  /** 查询当前是否已安装（幂等、只读，不触发下载） */
  status: () => Promise<PluginInstalledStatus>
  /**
   * 安装（幂等：已装应直接返回）。失败抛错；被取消抛错且 `signal.aborted === true`。
   * @param onProgress 进度回调（由本模块转发到 `plugin:progress`）
   * @param signal 取消信号（AbortController）
   */
  install: (onProgress: (p: PluginProgress) => void, signal: AbortSignal) => Promise<void>
  /** 卸载：删除该插件落盘的所有内容（幂等） */
  uninstall: () => Promise<void>
}

const handlers = new Map<string, PluginHandler>()
const aborts = new Map<string, AbortController>()

/** 注册一个插件（在 `registerBuiltinPlugins()` 里调用） */
export function registerPlugin(handler: PluginHandler): void {
  handlers.set(handler.id, handler)
}

/** 注册通用插件 IPC。与 `registerPlugin` 解耦，便于先注册后接线。 */
export function setupPluginIpcHandlers(): void {
  ipcMain.handle('plugin:list', async () => {
    const out: Record<string, PluginInstalledStatus> = {}
    for (const [id, h] of handlers) {
      try {
        out[id] = await h.status()
      } catch {
        out[id] = { installed: false }
      }
    }
    return out
  })

  ipcMain.handle('plugin:install', async (event, id: string) => {
    const h = handlers.get(id)
    if (!h) return { success: false, error: `未知插件：${id}` }
    // 同一插件重复点安装：先取消上一次，避免两个下载并行
    aborts.get(id)?.abort()
    const ac = new AbortController()
    aborts.set(id, ac)
    try {
      await h.install((p) => {
        if (!event.sender.isDestroyed()) event.sender.send('plugin:progress', { id, ...p })
      }, ac.signal)
      return { success: true }
    } catch (err) {
      // 取消不是失败：不回 error，渲染层据 cancelled 静默复位
      if (ac.signal.aborted) return { success: false, cancelled: true }
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      if (aborts.get(id) === ac) aborts.delete(id)
    }
  })

  ipcMain.handle('plugin:cancel', (_event, id: string) => {
    aborts.get(id)?.abort()
    aborts.delete(id)
    return { success: true }
  })

  ipcMain.handle('plugin:uninstall', async (_event, id: string) => {
    const h = handlers.get(id)
    if (!h) return { success: false, error: `未知插件：${id}` }
    try {
      await h.uninstall()
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
