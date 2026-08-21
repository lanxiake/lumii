/**
 * 版本控制 (VCS) 相关 API
 */
import { ipcRenderer } from 'electron'

export const vcsApi = {
  ensureInit: () => ipcRenderer.invoke('vcs:ensureInit'),
  commit: (opts?: { message?: string }) => ipcRenderer.invoke('vcs:commit', opts),
  log: (opts?: { limit?: number; offset?: number }) => ipcRenderer.invoke('vcs:log', opts),
  statusDiff: (opts?: { baseOid?: string }) => ipcRenderer.invoke('vcs:statusDiff', opts),
  diff: (opts: { fromOid: string; toOid: string; withHunks?: boolean }) =>
    ipcRenderer.invoke('vcs:diff', opts),
  diffFile: (opts: { fromOid: string; toOid: string; filepath: string }) =>
    ipcRenderer.invoke('vcs:diffFile', opts),
  readFileAt: (opts: { oid: string; filepath: string }) =>
    ipcRenderer.invoke('vcs:readFileAt', opts),
  rollback: (opts: { oid: string }) => ipcRenderer.invoke('vcs:rollback', opts),
  revertFile: (opts: { oid: string; filepath: string }) =>
    ipcRenderer.invoke('vcs:revertFile', opts),
  findCommitByConversation: (opts: { conversationId: string }) =>
    ipcRenderer.invoke('vcs:findCommitByConversation', opts),
}
