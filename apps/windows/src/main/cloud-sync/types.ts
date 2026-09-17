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
  /**
   * 分级传输阈值（字节）：≤ 此值的文件走阶段一（完整同步流程，通常几十秒完成），
   * 更大者交给阶段二的大文件队列（`sync-large-queue`）分批传。
   *
   * 默认 1 MB —— 实测 68% 的文件只占 1.6% 的体积，阶段一几十秒即可覆盖 83% 的文件。
   */
  smallFileThresholdBytes?: number
  /** 阶段二每批上限（字节）。队列实现前为占位配置 */
  largeFileBatchBytes?: number
  /**
   * 排除规则（glob，相对 outputs 目录）：命中的路径**永不参与同步**（含阶段二）。
   * 例：`temp/**`、`*.tmp`
   */
  syncExcludePatterns?: string[]
  /**
   * 强制包含（glob，相对 outputs 目录）：命中者**无视分级阈值**直接走阶段一。
   * **排除优先于强制包含** —— 两者冲突时以不传为准。
   */
  syncForceIncludePatterns?: string[]
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
