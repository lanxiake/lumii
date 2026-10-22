import { ipcMain, shell } from 'electron'

import { getExtensionControl, type PluginTarget } from '../plugins/control'
import {
  getClientPluginStateReport,
  setClientPluginStateReport,
} from '../client-plugin-state-report'
import { createSamplePlugin } from '../plugins/external/template'

/**
 * 设置页「扩展」页签的数据面 + Agent 自举开发的状态面。
 *
 * 通道只有八个：列表、两个开关、生成示例、渲染层状态上报、重启、打开目录、删除。
 * **不加**运行日志/内存之类的通道——那些在日志与 `/status` 里已经有了。
 *
 * 开关的生效时机不同（主进程要重启、客户端插件 ≤1 秒），返回里带
 * `restartRequired` / `pendingRestart`，由 UI 负责如实显示。
 */
export interface ExtensionIpcDeps {
  /** 重启当前客户端（`index.ts` 注入已有的 `requestAppRestart`） */
  restart?: () => void
}

function isTarget(value: unknown): value is PluginTarget {
  if (typeof value !== 'object' || value === null) return false
  const t = value as Record<string, unknown>
  return (
    (t.kind === 'builtin' || t.kind === 'external' || t.kind === 'client') &&
    typeof t.id === 'string' &&
    (t.dir === undefined || typeof t.dir === 'string')
  )
}

export function setupExtensionIpcHandlers(deps: ExtensionIpcDeps = {}): void {
  ipcMain.handle('extension:list', () => getExtensionControl()?.list() ?? [])

  ipcMain.handle('extension:set-enabled', (_event, id: string, enabled: boolean) => {
    const control = getExtensionControl()
    if (!control) return { ok: false, error: '扩展宿主尚未就绪' }
    return control.setEnabled(id, enabled)
  })

  ipcMain.handle('extension:set-client-enabled', (_event, id: string, enabled: boolean) => {
    const control = getExtensionControl()
    if (!control) return { ok: false, error: '扩展宿主尚未就绪' }
    return control.setClientEnabled(id, enabled)
  })

  ipcMain.handle('extension:create-sample', () => createSamplePlugin())

  /**
   * 渲染层上报客户端插件加载状态（fire-and-forget）。
   *
   * 客户端插件跑在渲染层，加载失败的具体原因（语法错误 / 契约写错 / 槽位撞车）
   * 主进程看不到；Agent 的 `plugin_dev status` 要靠这份快照。
   */
  ipcMain.on('extension:client-states', (_event, states: unknown) => {
    const before = getClientPluginStateReport()
    setClientPluginStateReport(states)
    const after = getClientPluginStateReport()
    const changed =
      before.states.length !== after.states.length ||
      before.states.some((s, i) => {
        const next = after.states[i]
        return !next || s.id !== next.id || s.state !== next.state || s.error !== next.error
      })
    // 只在真的变了时记一行：上报按签名变化触发，正常是低频事件
    if (changed) {
      console.log(`[extension] 渲染层上报 ${after.states.length} 个客户端插件状态`)
    }
  })

  ipcMain.handle('extension:open-dir', async (_event, value: unknown) => {
    if (!isTarget(value)) return { ok: false, error: '非法的扩展目标' }
    const control = getExtensionControl()
    if (!control) return { ok: false, error: '扩展宿主尚未就绪' }
    const dir = control.dirOf(value)
    if (!dir) return { ok: false, error: '该扩展没有可打开的目录' }
    // shell.openPath 返回空串表示成功，非空是系统给的错误文案
    const error = await shell.openPath(dir)
    return error ? { ok: false, error } : { ok: true }
  })

  ipcMain.handle('extension:delete', async (_event, value: unknown) => {
    if (!isTarget(value)) return { ok: false, error: '非法的扩展目标' }
    const control = getExtensionControl()
    if (!control) return { ok: false, error: '扩展宿主尚未就绪' }
    return control.remove(value)
  })

  ipcMain.handle('extension:restart', () => {
    if (!deps.restart) return { ok: false, error: '重启入口未注入' }
    try {
      // 重启是异步进行的（打包版 relaunch / dev 版排脚本），先回执再退
      setTimeout(deps.restart, 100)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: `重启失败：${(err as Error).message}` }
    }
  })
}
