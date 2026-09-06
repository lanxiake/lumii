/**
 * 云同步 IPC handlers + 状态推送。
 *
 * 本层不碰 token 明文编解码，只调 sync-config 的封装函数；
 * manager 是 EventEmitter，status 事件在此转发到渲染层。
 */
import { ipcMain, Notification } from 'electron'
import type { BrowserWindow } from 'electron'
import git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import { getCloudSyncManager } from './sync-accessor'
import { loadCloudSyncConfig, saveConfigFromView, toConfigView, decryptToken } from './sync-config'
import { getProvider } from './git-provider'
import { resolveActiveWorkspaceDir } from '../workspace-paths'
import type { CloudSyncConfig, CloudSyncConfigView } from './types'

interface CloudSyncIpcDeps {
  getMainWindow: () => BrowserWindow | null
  onConfigChanged?: (cfg: CloudSyncConfig) => void
}

let deps: CloudSyncIpcDeps | null = null

export function setCloudSyncIpcDeps(d: CloudSyncIpcDeps): void {
  deps = d
}

/** 日志/错误信息脱敏：替换明文 token */
function sanitize(msg: string): string {
  const token = decryptToken(loadCloudSyncConfig().tokenEnc)
  return token ? msg.split(token).join('***') : msg
}

export function registerCloudSyncIpcHandlers(): void {
  if (!deps) throw new Error('CloudSyncIpc deps not set')

  ipcMain.handle('cloudSync:getConfig', () => {
    const view = toConfigView(loadCloudSyncConfig())
    view.workspaceDir = resolveActiveWorkspaceDir().replace(/\\/g, '/')
    return { success: true, data: view }
  })

  ipcMain.handle('cloudSync:setConfig', (_e, view: CloudSyncConfigView) => {
    try {
      const next = saveConfigFromView(view)
      deps!.onConfigChanged?.(next)
      return { success: true, data: toConfigView(next) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('cloudSync:testConnection', async (_e, view: CloudSyncConfigView) => {
    const provider = getProvider(view.provider)
    const urlOk = provider.validateUrl(view.repoUrl)
    if (!urlOk.ok) return { success: false, error: urlOk.error }
    const token =
      view.token && view.token.trim() !== '' ? view.token : decryptToken(loadCloudSyncConfig().tokenEnc)
    try {
      await git.getRemoteInfo({ http, url: view.repoUrl.trim(), onAuth: () => provider.auth(token) })
      return { success: true }
    } catch (err) {
      return { success: false, error: sanitize(err instanceof Error ? err.message : String(err)) }
    }
  })

  ipcMain.handle('cloudSync:getStatus', () => ({
    success: true,
    data: getCloudSyncManager()?.getStatus() ?? { state: 'idle' as const },
  }))

  ipcMain.handle('cloudSync:syncNow', async () => {
    const m = getCloudSyncManager()
    if (!m) return { success: false, state: 'error' as const }
    return m.sync()
  })

  ipcMain.handle(
    'cloudSync:resolveConflict',
    async (_e, strategy: 'keep-local' | 'keep-remote' | 'per-file', choices?: { path: string; side: 'local' | 'remote' }[]) => {
      const m = getCloudSyncManager()
      if (!m) return { success: false, error: '云同步未初始化' }
      return m.resolveConflict(strategy, choices)
    },
  )

  ipcMain.handle(
    'cloudSync:readFileAt',
    async (_e, oid: 'local' | 'remote' | 'base', filepath: string) => {
      const m = getCloudSyncManager()
      if (!m) return { success: false, data: null }
      return { success: true, data: await m.readFileAt(oid, filepath) }
    },
  )

  // 状态推送：manager EventEmitter → 渲染层；冲突态过渡时弹系统通知
  let lastPushedState: string | null = null
  getCloudSyncManager()?.on('status', (status) => {
    deps?.getMainWindow()?.webContents.send('cloudSync:status', status)
    if (status.state === 'conflict' && lastPushedState !== 'conflict') {
      const count = status.conflict?.files.length ?? 0
      try {
        if (Notification.isSupported()) {
          new Notification({
            title: '云同步检测到冲突',
            body: `涉及 ${count} 个文件，等待 Agent 处理`,
          }).show()
        }
      } catch {
        /* 通知失败不影响同步 */
      }
    }
    lastPushedState = status.state
  })
}
