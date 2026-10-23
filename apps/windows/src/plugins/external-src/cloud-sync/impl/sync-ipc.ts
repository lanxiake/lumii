/**
 * 云同步 IPC handlers + 状态推送。
 *
 * 本层不碰 token 明文编解码，只调 sync-config 的封装函数；
 * manager 是 EventEmitter，status 事件在此转发到渲染层。
 */
import { Notification } from 'electron'
import type { BrowserWindow } from 'electron'
import git from 'isomorphic-git'
import { gitHttp } from './git-http'
import { loadCloudSyncConfig, saveConfigFromView, toConfigView, decryptToken } from './sync-config'
import { getProvider } from './git-provider'
import { loadSyncLogs } from './sync-log'
import { resolveActiveWorkspaceDir } from '../../../../main/workspace-paths'
import { getAgentRuntimeBridge } from '../../../../main/ipc/agent-runtime-ipc'
import type { CloudSyncConfig, CloudSyncConfigView } from '../../../../shared/cloud-sync'
import type { IpcHandleRegistrar } from '../../../../main/kernel/ipc-registry'
import type { CloudSyncManager } from './sync-manager'

interface CloudSyncIpcDeps {
  getMainWindow: () => BrowserWindow | null
  onConfigChanged?: (cfg: CloudSyncConfig) => void
}


/** 日志/错误信息脱敏：替换明文 token */
function sanitize(msg: string): string {
  const token = decryptToken(loadCloudSyncConfig().tokenEnc)
  return token ? msg.split(token).join('***') : msg
}

/**
 * 注册云同步 IPC，绑定到扩展装配时的 manager 实例。
 *
 * 通道经**注册器**挂载（扩展 apply 里传 `ctx.registerIpc`），停用/热重载随作用域摘除。
 */
export function registerCloudSyncIpc(
  registrar: IpcHandleRegistrar,
  manager: CloudSyncManager,
  deps: CloudSyncIpcDeps,
): void {

  registrar.handle('cloudSync:getConfig', () => {
    const view = toConfigView(loadCloudSyncConfig())
    view.workspaceDir = resolveActiveWorkspaceDir().replace(/\\/g, '/')
    return { success: true, data: view }
  })

  registrar.handle('cloudSync:setConfig', (_e, view: CloudSyncConfigView) => {
    try {
      const next = saveConfigFromView(view)
      deps.onConfigChanged?.(next)
      return { success: true, data: toConfigView(next) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  registrar.handle('cloudSync:testConnection', async (_e, view: CloudSyncConfigView) => {
    const provider = getProvider(view.provider)
    const urlOk = provider.validateUrl(view.repoUrl)
    if (!urlOk.ok) return { success: false, error: urlOk.error }
    const token =
      view.token && view.token.trim() !== '' ? view.token : decryptToken(loadCloudSyncConfig().tokenEnc)
    try {
      await git.getRemoteInfo({ http: gitHttp, url: view.repoUrl.trim(), onAuth: () => provider.auth(token) })
      return { success: true }
    } catch (err) {
      return { success: false, error: sanitize(err instanceof Error ? err.message : String(err)) }
    }
  })

  registrar.handle('cloudSync:getStatus', () => ({
    success: true,
    data: manager?.getStatus() ?? { state: 'idle' as const },
  }))

  registrar.handle('cloudSync:getLogs', () => ({
    success: true,
    data: loadSyncLogs(),
  }))

  registrar.handle('cloudSync:syncNow', async () => {
    const m = manager
    if (!m) return { success: false, state: 'error' as const }
    return m.sync()
  })

  registrar.handle(
    'cloudSync:readFileAt',
    async (_e, oid: 'local' | 'remote' | 'base', filepath: string) => {
      const m = manager
      if (!m) return { success: false, data: null }
      return { success: true, data: await m.readFileAt(oid, filepath) }
    },
  )

  // 手动重试 Agent 处理冲突（设置页「重试处理」按钮）
  registrar.handle('cloudSync:retryConflict', async () => {
    const m = manager
    if (!m?.getConflict()) return { success: false, error: '当前无冲突' }
    const bridge = getAgentRuntimeBridge()
    if (!bridge?.isInitialized) return { success: false, error: 'Agent 运行时未就绪' }
    const summary = await bridge.executeSyncConflictGoal()
    return { success: true, result: summary ?? '无冲突待处理' }
  })

  // 批量删除安全阀（2026-09-16 事故修复）：超阈值删除必须由用户显式确认才放行。
  // 确认绑定到待删集合指纹 —— 集合变化即失效，自动同步永远拿不到匹配指纹。
  registrar.handle('cloudSync:getPendingMassDelete', () => {
    const m = manager
    return { success: true, data: m?.getPendingMassDelete() ?? null }
  })

  registrar.handle('cloudSync:confirmMassDelete', (_e, fingerprint: string) => {
    const m = manager
    if (!m) return { success: false, error: '云同步未初始化' }
    return m.confirmMassDelete(fingerprint)
  })

  // 阶段二（大文件队列）进度：供设置页展示「还剩多少在传」
  registrar.handle('cloudSync:getLargeQueueStats', () => {
    const m = manager
    return { success: true, data: m?.getLargeQueueStats() ?? null }
  })

  // 状态推送：manager EventEmitter → 渲染层；冲突态过渡时弹系统通知
  let lastPushedState: string | null = null
  manager?.on('status', (status) => {
    deps.getMainWindow()?.webContents.send('cloudSync:status', status)
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
