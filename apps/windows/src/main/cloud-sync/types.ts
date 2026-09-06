/**
 * 云同步类型定义。
 * 跨端友好：不含 Electron 专有概念（token 密文存于 CloudSyncConfig.tokenEnc）。
 */

/** Git 提供商类型 */
export type GitProviderType = 'gitcode' | 'github' | 'gitee'

/** 持久化配置（tokenEnc 为 safeStorage 密文或 plain: 前缀明文兜底，绝不明文落盘） */
export interface CloudSyncConfig {
  enabled: boolean
  provider: GitProviderType
  repoUrl: string
  branch: string
  intervalMinutes: number
  tokenEnc?: string
}

/** 渲染进程可见视图（token 只给掩码，不回传明文） */
export interface CloudSyncConfigView {
  enabled: boolean
  provider: GitProviderType
  repoUrl: string
  branch: string
  intervalMinutes: number
  /** 仅 setConfig 时填写；空串/缺省 = 沿用已保存 token */
  token?: string
  tokenMasked: string
  workspaceDir: string
}

export type SyncState = 'idle' | 'syncing' | 'conflict' | 'error'

export interface SyncStatus {
  state: SyncState
  lastSyncAt?: number
  lastError?: string
  message?: string
  conflict?: ConflictInfo
}

/** 冲突信息（filepaths 等来自 MergeConflictError.data；baseOid 来自 findMergeBase） */
export interface ConflictInfo {
  files: string[]
  bothModified: string[]
  deleteByUs: string[]
  deleteByTheirs: string[]
  localOid: string
  remoteOid: string
  baseOid: string
}
