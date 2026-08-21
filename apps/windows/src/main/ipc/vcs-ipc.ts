/**
 * 工作空间 Git 版本控制 (VCS) IPC handlers
 */
import { ipcMain } from 'electron'
import { getWorkspaceVcs } from '../workspace-vcs/vcs-snapshot'

interface VcsIpcDeps {
  getWorkspaceDir: () => string
  log: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
  }
}

let deps: VcsIpcDeps | null = null

export function setVcsIpcDeps(d: VcsIpcDeps): void {
  deps = d
}

function vcsWarn(msg: string): void {
  if (!deps) return
  deps.log.warn(`[VCS-IPC] ${msg}`)
}

export function registerVcsIpcHandlers(): void {
  if (!deps) throw new Error('VcsIpc deps not set')

  ipcMain.handle('vcs:ensureInit', async () => {
    const repo = getWorkspaceVcs(deps!.getWorkspaceDir())
    await repo.ensureInitialized()
    return { ok: true }
  })

  ipcMain.handle('vcs:commit', async (_event, opts?: { message?: string }) => {
    try {
      const repo = getWorkspaceVcs(deps!.getWorkspaceDir())
      const commit = await repo.commit({
        author: 'user',
        message: opts?.message || '手动保存版本',
      })
      return { success: true, data: commit }
    } catch (err) {
      vcsWarn(`commit 失败: ${err instanceof Error ? err.message : String(err)}`)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('vcs:log', async (_event, opts?: { limit?: number; offset?: number }) => {
    try {
      const repo = getWorkspaceVcs(deps!.getWorkspaceDir())
      const entries = await repo.log(opts)
      return { success: true, data: entries }
    } catch (err) {
      vcsWarn(`log 失败: ${err instanceof Error ? err.message : String(err)}`)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('vcs:statusDiff', async (_event, opts?: { baseOid?: string }) => {
    try {
      const repo = getWorkspaceVcs(deps!.getWorkspaceDir())
      const diff = await repo.statusDiff(opts?.baseOid)
      return { success: true, data: diff }
    } catch (err) {
      vcsWarn(`statusDiff 失败: ${err instanceof Error ? err.message : String(err)}`)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('vcs:diff', async (_event, opts: { fromOid: string; toOid: string; withHunks?: boolean }) => {
    try {
      const repo = getWorkspaceVcs(deps!.getWorkspaceDir())
      const diff = await repo.diffCommits(opts.fromOid, opts.toOid, { withHunks: opts.withHunks })
      return { success: true, data: diff }
    } catch (err) {
      vcsWarn(`diff 失败: ${err instanceof Error ? err.message : String(err)}`)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(
    'vcs:diffFile',
    async (_event, opts: { fromOid: string; toOid: string; filepath: string }) => {
      try {
        const repo = getWorkspaceVcs(deps!.getWorkspaceDir())
        const entry = await repo.diffFile(opts.fromOid, opts.toOid, opts.filepath)
        return { success: true, data: entry }
      } catch (err) {
        vcsWarn(`diffFile 失败: ${err instanceof Error ? err.message : String(err)}`)
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle('vcs:readFileAt', async (_event, opts: { oid: string; filepath: string }) => {
    try {
      const repo = getWorkspaceVcs(deps!.getWorkspaceDir())
      const content = await repo.readFileAt(opts.oid, opts.filepath)
      return { success: true, data: content }
    } catch (err) {
      vcsWarn(`readFileAt 失败: ${err instanceof Error ? err.message : String(err)}`)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('vcs:rollback', async (_event, opts: { oid: string }) => {
    try {
      const repo = getWorkspaceVcs(deps!.getWorkspaceDir())
      const result = await repo.rollbackTo(opts.oid)
      deps!.log.info(`[VCS-IPC] 回滚完成，恢复至 oid=${result.restoredOid.slice(0, 8)}`)
      return { success: true, data: result }
    } catch (err) {
      vcsWarn(`rollback 失败: ${err instanceof Error ? err.message : String(err)}`)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('vcs:revertFile', async (_event, opts: { oid: string; filepath: string }) => {
    try {
      const repo = getWorkspaceVcs(deps!.getWorkspaceDir())
      const result = await repo.revertFile(opts.oid, opts.filepath)
      deps!.log.info(`[VCS-IPC] 单文件撤销完成 ${opts.filepath} → ${(opts.oid || 'HEAD').slice(0, 8)}`)
      return { success: true, data: result }
    } catch (err) {
      vcsWarn(`revertFile 失败: ${err instanceof Error ? err.message : String(err)}`)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('vcs:findCommitByConversation', async (_event, opts: { conversationId: string }) => {
    try {
      const repo = getWorkspaceVcs(deps!.getWorkspaceDir())
      const commit = await repo.findCommitByConversation(opts.conversationId)
      return { success: true, data: commit }
    } catch (err) {
      vcsWarn(`findCommitByConversation 失败: ${err instanceof Error ? err.message : String(err)}`)
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
