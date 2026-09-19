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
  /**
   * 同步请求已提交但尚未真正开始导出时，排在它前面的任务数（undefined = 未排队）。
   *
   * 「真正开始」的界是**拿到工作区锁**那一刻，不是 sync() 被调用的那一刻 ——
   * 后者会在还排队时就宣告「开始同步」，正是这个字段当初要消除的假象。
   *
   * `state` 现在是 `syncing`（2026-09-19 起）：等锁那段时间也算 syncing，否则
   * watcher 的 commitLocalChanges 与大文件队列会在空档里插进来。此前的注释说
   * 「state 刻意保持 idle」，那是在「整条 syncInner 都占着工作区锁」的旧设计下
   * 才成立的 —— 那时排队约等于整轮同步都在等，与现在只等导出那一步不同。
   */
  queuedBehind?: number
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
