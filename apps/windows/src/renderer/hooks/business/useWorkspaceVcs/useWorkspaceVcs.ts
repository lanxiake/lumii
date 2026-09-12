/**
 * useWorkspaceVcs — 工作空间 Git 版本管理 Hook
 *
 * 对 window.electronAPI.vcs 命名空间做轻量封装，返回版本历史、未提交变更与操作方法。
 * 历史与未提交变更的拉取走通用 useQuery（竞态保护 + 5 分钟缓存）；其余为命令式方法。
 */

import { useCallback, useEffect } from 'react'
import { useQuery } from '../../common/useQuery'

/** 运行时读取 VCS API（勿在模块顶层缓存，避免 preload 热更后仍指向旧对象） */
function getVcs() {
  return (window as any).electronAPI?.vcs as {
    ensureInit(): Promise<{ ok: boolean }>
    commit(opts?: { message?: string }): Promise<{ success: boolean; data?: any }>
    log(opts?: { limit?: number; offset?: number }): Promise<{ success: boolean; data?: any }>
    statusDiff(opts?: { baseOid?: string }): Promise<{ success: boolean; data?: any }>
    diff(opts: { fromOid: string; toOid: string; withHunks?: boolean }): Promise<{ success: boolean; data?: any }>
    diffFile?(opts: { fromOid: string; toOid: string; filepath: string }): Promise<{ success: boolean; data?: any }>
    readFileAt(opts: { oid: string; filepath: string }): Promise<{ success: boolean; data?: any }>
    rollback(opts: { oid: string }): Promise<{ success: boolean; data?: any }>
    revertFile(opts: { oid: string; filepath: string }): Promise<{ success: boolean; data?: any }>
    findCommitByConversation(opts: { conversationId: string }): Promise<{ success: boolean; data?: any }>
  } | undefined
}

export interface VcsLogEntry {
  oid: string
  message: string
  timestamp: number
  author: 'agent' | 'user'
  conversationId?: string
  runId?: string
}

export interface VcsDiffItem {
  filepath: string
  status: 'added' | 'modified' | 'deleted'
  insertions: number
  deletions: number
  /** 逐行 hunks（按需加载） */
  hunks?: VcsDiffHunk[]
  truncated?: boolean
  skipReason?: string
}

export interface VcsDiffHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export interface VcsRollbackResult {
  backupOid: string | null
  restoredOid: string
}

export function useWorkspaceVcs() {
  /**
   * 历史与未提交变更改走通用 useQuery 承载状态（竞态保护 + 5 分钟缓存）。
   * 刻意不用它的「挂载自动加载」：主进程 ensureInit 首次并发会两次通过
   * 未初始化检查、产生重复初始提交，因此必须保持「先 ensureInit 再查询」
   * 的既有顺序，由 refresh() 显式驱动。
   */
  const historyQuery = useQuery<VcsLogEntry[]>({
    queryKey: ['workspace-vcs', 'history'],
    queryFn: async () => {
      const vcs = getVcs()
      if (!vcs) return []
      const res = await vcs.log({ limit: 50 })
      return res.success && res.data ? (res.data as VcsLogEntry[]) : []
    },
    enabled: false,
  })

  const uncommittedQuery = useQuery<VcsDiffItem[]>({
    queryKey: ['workspace-vcs', 'uncommitted'],
    queryFn: async () => {
      const vcs = getVcs()
      if (!vcs) return []
      const res = await vcs.statusDiff()
      return res.success && res.data ? (res.data as VcsDiffItem[]) : []
    },
    enabled: false,
  })

  const ensureInit = useCallback(async () => {
    const vcs = getVcs()
    if (!vcs) return
    await vcs.ensureInit()
  }, [])

  const commit = useCallback(async (message?: string) => {
    const vcs = getVcs()
    if (!vcs) throw new Error('VCS 不可用')
    const res = await vcs.commit({ message })
    if (!res.success) throw new Error((res as any).error as string)
    return res.data as VcsLogEntry | null
  }, [])

  const rollback = useCallback(async (oid: string): Promise<VcsRollbackResult> => {
    const vcs = getVcs()
    if (!vcs) throw new Error('VCS 不可用')
    const res = await vcs.rollback({ oid })
    if (!res.success) throw new Error((res as any).error as string)
    return res.data as VcsRollbackResult
  }, [])

  /** 获取两个版本间不含 hunks 的文件差异列表。 */
  const diffList = useCallback(async (fromOid: string, toOid: string): Promise<VcsDiffItem[]> => {
    const vcs = getVcs()
    if (!vcs) return []
    const res = await vcs.diff({ fromOid, toOid, withHunks: false })
    if (res.success && res.data) return res.data as VcsDiffItem[]
    return []
  }, [])

  /**
   * 获取两个版本间指定文件的逐行差异。
   * preload 未热更新时可能缺少 diffFile，此时返回 truncated 占位，避免整页崩溃。
   */
  const diffFile = useCallback(
    async (fromOid: string, toOid: string, filepath: string): Promise<VcsDiffItem | null> => {
      const vcs = getVcs()
      if (!vcs) return null
      if (typeof vcs.diffFile !== 'function') {
        console.warn('[useWorkspaceVcs] electronAPI.vcs.diffFile 不可用，请重启应用以加载最新 preload')
        return {
          filepath,
          status: 'modified',
          insertions: 0,
          deletions: 0,
          hunks: [],
          truncated: true,
          skipReason: '请重启应用以启用逐行差异（preload 未更新）',
        }
      }
      const res = await vcs.diffFile({ fromOid, toOid, filepath })
      if (res.success && res.data) return res.data as VcsDiffItem
      return null
    },
    [],
  )

  /** 兼容旧调用：先获取文件列表，再逐文件加载 hunks。 */
  const diffWithHunks = useCallback(
    async (fromOid: string, toOid: string): Promise<VcsDiffItem[]> => {
      const items = await diffList(fromOid, toOid)
      return Promise.all(
        items.map(async (item) => {
          const detailed = await diffFile(fromOid, toOid, item.filepath)
          return detailed ?? item
        }),
      )
    },
    [diffFile, diffList],
  )

  /** 读取某版本下单文件内容（用于并排对比视图）；oid 传 'HEAD' 读最近提交，'WORKTREE' 读工作区当前 */
  const readFileAt = useCallback(async (oid: string, filepath: string): Promise<string | null> => {
    const vcs = getVcs()
    if (!vcs) return null
    const res = await vcs.readFileAt({ oid, filepath })
    if (res.success && typeof res.data === 'string') return res.data
    return res.success ? (res.data as string | null) ?? null : null
  }, [])

  /** 撤销单个文件到指定版本（oid 传 'HEAD' 撤销未提交变更）。不产生提交。 */
  const revertFile = useCallback(async (oid: string, filepath: string): Promise<void> => {
    const vcs = getVcs()
    if (!vcs) throw new Error('VCS 不可用')
    const res = await vcs.revertFile({ oid, filepath })
    if (!res.success) throw new Error((res as any).error as string)
  }, [])

  /** 查找匹配指定 conversationId 的最近提交（用于回溯联动） */
  const findCommitByConversation = useCallback(async (conversationId: string): Promise<VcsLogEntry | null> => {
    const vcs = getVcs()
    if (!vcs) return null
    const res = await vcs.findCommitByConversation({ conversationId })
    if (res.success && res.data) return res.data as VcsLogEntry
    return null
  }, [])

  const refresh = useCallback(async () => {
    await ensureInit()
    // allSettled：与原实现一致——单个查询失败不向调用方抛错（错误经 error 暴露或被静默）
    await Promise.allSettled([historyQuery.refetch(), uncommittedQuery.refetch()])
  }, [ensureInit, historyQuery.refetch, uncommittedQuery.refetch])

  useEffect(() => {
    void refresh()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const history = historyQuery.data ?? []
  const uncommittedDiff = uncommittedQuery.data ?? []
  /** 与原实现一致：仅历史拉取计入 loading（未提交变更静默刷新） */
  const loading = historyQuery.isLoading
  /** 与原实现一致：仅历史拉取失败暴露 error */
  const error = historyQuery.error ? historyQuery.error.message : null

  return {
    history,
    uncommittedDiff,
    loading,
    error,
    commit,
    rollback,
    revertFile,
    readFileAt,
    diffList,
    diffFile,
    diffWithHunks,
    findCommitByConversation,
    refresh,
  }
}
