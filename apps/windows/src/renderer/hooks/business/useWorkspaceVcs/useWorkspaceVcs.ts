/**
 * useWorkspaceVcs — 工作空间 Git 版本管理 Hook
 *
 * 对 window.electronAPI.vcs 命名空间做轻量封装，返回版本历史、未提交变更与操作方法。
 */

import { useState, useCallback, useEffect } from 'react'

const VCS = (window as any).electronAPI?.vcs as {
  ensureInit(): Promise<{ ok: boolean }>
  commit(opts?: { message?: string }): Promise<{ success: boolean; data?: any }>
  log(opts?: { limit?: number; offset?: number }): Promise<{ success: boolean; data?: any }>
  statusDiff(opts?: { baseOid?: string }): Promise<{ success: boolean; data?: any }>
  diff(opts: { fromOid: string; toOid: string; withHunks?: boolean }): Promise<{ success: boolean; data?: any }>
  diffFile(opts: { fromOid: string; toOid: string; filepath: string }): Promise<{ success: boolean; data?: any }>
  readFileAt(opts: { oid: string; filepath: string }): Promise<{ success: boolean; data?: any }>
  rollback(opts: { oid: string }): Promise<{ success: boolean; data?: any }>
  revertFile(opts: { oid: string; filepath: string }): Promise<{ success: boolean; data?: any }>
  findCommitByConversation(opts: { conversationId: string }): Promise<{ success: boolean; data?: any }>
} | undefined

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
  /** 逐行 hunks（vcs:diff withHunks 时填充） */
  hunks?: VcsDiffHunk[]
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
  const [history, setHistory] = useState<VcsLogEntry[]>([])
  const [uncommittedDiff, setUncommittedDiff] = useState<VcsDiffItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ensureInit = useCallback(async () => {
    if (!VCS) return
    await VCS.ensureInit()
  }, [])

  const loadHistory = useCallback(async (limit = 50) => {
    if (!VCS) return
    setLoading(true)
    try {
      const res = await VCS.log({ limit })
      if (res.success && res.data) setHistory(res.data as VcsLogEntry[])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  const loadUncommitted = useCallback(async () => {
    if (!VCS) return
    try {
      const res = await VCS.statusDiff()
      if (res.success && res.data) setUncommittedDiff(res.data as VcsDiffItem[])
    } catch {
      // 静默处理
    }
  }, [])

  const commit = useCallback(async (message?: string) => {
    if (!VCS) throw new Error('VCS 不可用')
    const res = await VCS.commit({ message })
    if (!res.success) throw new Error((res as any).error as string)
    return res.data as VcsLogEntry | null
  }, [])

  const rollback = useCallback(async (oid: string): Promise<VcsRollbackResult> => {
    if (!VCS) throw new Error('VCS 不可用')
    const res = await VCS.rollback({ oid })
    if (!res.success) throw new Error((res as any).error as string)
    return res.data as VcsRollbackResult
  }, [])

  /** 获取两个版本间不含 hunks 的文件差异列表。 */
  const diffList = useCallback(async (fromOid: string, toOid: string): Promise<VcsDiffItem[]> => {
    if (!VCS) return []
    const res = await VCS.diff({ fromOid, toOid, withHunks: false })
    if (res.success && res.data) return res.data as VcsDiffItem[]
    return []
  }, [])

  /** 获取两个版本间指定文件的逐行差异。 */
  const diffFile = useCallback(
    async (fromOid: string, toOid: string, filepath: string): Promise<VcsDiffItem | null> => {
      if (!VCS) return null
      const res = await VCS.diffFile({ fromOid, toOid, filepath })
      if (res.success && res.data) return res.data as VcsDiffItem
      return null
    },
    [],
  )

  /** 兼容旧调用：先获取文件列表，再逐文件加载 hunks。 */
  const diffWithHunks = useCallback(
    async (fromOid: string, toOid: string): Promise<VcsDiffItem[]> => {
      const items = await diffList(fromOid, toOid)
      const detailedItems = await Promise.all(items.map((item) => diffFile(fromOid, toOid, item.filepath)))
      return detailedItems.filter((item): item is VcsDiffItem => item !== null)
    },
    [diffFile, diffList],
  )

  /** 读取某版本下单文件内容（用于并排对比视图）；oid 传 'HEAD' 读最近提交，'WORKTREE' 读工作区当前 */
  const readFileAt = useCallback(async (oid: string, filepath: string): Promise<string | null> => {
    if (!VCS) return null
    const res = await VCS.readFileAt({ oid, filepath })
    if (res.success && typeof res.data === 'string') return res.data
    return res.success ? (res.data as string | null) ?? null : null
  }, [])

  /** 撤销单个文件到指定版本（oid 传 'HEAD' 撤销未提交变更）。不产生提交。 */
  const revertFile = useCallback(async (oid: string, filepath: string): Promise<void> => {
    if (!VCS) throw new Error('VCS 不可用')
    const res = await VCS.revertFile({ oid, filepath })
    if (!res.success) throw new Error((res as any).error as string)
  }, [])

  /** 查找匹配指定 conversationId 的最近提交（用于回溯联动） */
  const findCommitByConversation = useCallback(async (conversationId: string): Promise<VcsLogEntry | null> => {
    if (!VCS) return null
    const res = await VCS.findCommitByConversation({ conversationId })
    if (res.success && res.data) return res.data as VcsLogEntry
    return null
  }, [])

  const refresh = useCallback(async () => {
    await ensureInit()
    await Promise.all([loadHistory(), loadUncommitted()])
  }, [ensureInit, loadHistory, loadUncommitted])

  useEffect(() => {
    void refresh()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
