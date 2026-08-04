import { useState, useEffect, useCallback, useRef } from 'react'

export type MemPalaceStatus = {
  installed: boolean
  runtimeDir: string
}

export type InstallPhase = 'idle' | 'installing' | 'done' | 'error' | 'uninstalling'

export interface MemPalaceDrawer {
  drawer_id: string
  wing: string
  room: string
  content_preview: string
  /** ISO 8601 时间戳，旧数据可能为空字符串 */
  filed_at?: string
}

export interface MemPalaceSearchItem {
  text: string
  wing: string
  room: string
  similarity: number
  drawer_id: string
  created_at?: string
}

const PAGE_SIZE = 20

export function useMemPalace() {
  const [status, setStatus] = useState<MemPalaceStatus | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [installPhase, setInstallPhase] = useState<InstallPhase>('idle')
  const [installProgress, setInstallProgress] = useState('')
  const [installError, setInstallError] = useState<string | null>(null)

  // 列表状态
  const [drawers, setDrawers] = useState<MemPalaceDrawer[]>([])
  const [totalDrawers, setTotalDrawers] = useState(0)
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [currentPage, setCurrentPage] = useState(0)

  // 搜索状态
  const [searchResults, setSearchResults] = useState<MemPalaceSearchItem[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [isSearchMode, setIsSearchMode] = useState(false)

  // 删除/清空状态
  const [deleteLoading, setDeleteLoading] = useState<string | null>(null)
  const [clearLoading, setClearLoading] = useState(false)
  const [clearProgress, setClearProgress] = useState(0)

  const clearUnsubRef = useRef<(() => void) | null>(null)

  const refresh = useCallback(async () => {
    setIsLoading(true)
    try {
      const result = await window.electronAPI.mempalace.getStatus()
      setStatus(result)
    } catch (err) {
      console.error('[useMemPalace] 获取状态失败:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const install = useCallback(async () => {
    setInstallPhase('installing')
    setInstallError(null)
    setInstallProgress('准备安装...')

    const unsubscribe = window.electronAPI.mempalace.onInstallProgress((msg) => {
      setInstallProgress(msg)
    })

    try {
      const result = await window.electronAPI.mempalace.install()
      if (result.success) {
        setInstallPhase('done')
        await refresh()
      } else {
        setInstallPhase('error')
        setInstallError(result.error ?? '安装失败')
      }
    } catch (err) {
      setInstallPhase('error')
      setInstallError(err instanceof Error ? err.message : String(err))
    } finally {
      unsubscribe()
    }
  }, [refresh])

  const listDrawers = useCallback(async (page = 0) => {
    setListLoading(true)
    setListError(null)
    try {
      const result = await window.electronAPI.mempalace.list({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      })
      if ('error' in result && result.error) {
        setListError(result.error === 'not_installed' ? '记忆插件未安装' : (result.error as string))
        return
      }
      setDrawers(result.drawers ?? [])
      setTotalDrawers(result.total ?? 0)
      setCurrentPage(page)
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err))
    } finally {
      setListLoading(false)
    }
  }, [])

  const searchDrawers = useCallback(async (query: string) => {
    if (!query.trim()) return
    setSearchLoading(true)
    setIsSearchMode(true)
    setSearchQuery(query)
    try {
      const result = await window.electronAPI.mempalace.search({ query, limit: 20 })
      if ('error' in result && result.error) {
        setListError(result.error === 'not_installed' ? '记忆插件未安装' : (result.error as string))
        return
      }
      setSearchResults(result.results ?? [])
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err))
    } finally {
      setSearchLoading(false)
    }
  }, [])

  const exitSearch = useCallback(() => {
    setIsSearchMode(false)
    setSearchResults([])
    setSearchQuery('')
  }, [])

  const deleteDrawer = useCallback(async (drawerId: string) => {
    setDeleteLoading(drawerId)
    // 乐观更新
    setDrawers((prev) => prev.filter((d) => d.drawer_id !== drawerId))
    setSearchResults((prev) => prev.filter((d) => d.drawer_id !== drawerId))
    setTotalDrawers((prev) => Math.max(0, prev - 1))
    try {
      const result = await window.electronAPI.mempalace.delete(drawerId)
      if (!result.success) {
        // 回滚：重新加载当前页
        await listDrawers(currentPage)
      }
    } catch {
      await listDrawers(currentPage)
    } finally {
      setDeleteLoading(null)
    }
  }, [currentPage, listDrawers])

  const clearAllDrawers = useCallback(async (): Promise<boolean> => {
    setClearLoading(true)
    setClearProgress(0)

    clearUnsubRef.current = window.electronAPI.mempalace.onClearProgress((p) => {
      setClearProgress(p.deleted)
    })

    try {
      const result = await window.electronAPI.mempalace.clear()
      if (result.success) {
        setDrawers([])
        setTotalDrawers(0)
        setSearchResults([])
        setCurrentPage(0)
        return true
      }
      return false
    } catch {
      return false
    } finally {
      clearUnsubRef.current?.()
      clearUnsubRef.current = null
      setClearLoading(false)
      setClearProgress(0)
    }
  }, [])

  const uninstall = useCallback(async (): Promise<boolean> => {
    setInstallPhase('uninstalling')
    try {
      const result = await window.electronAPI.mempalace.uninstall()
      if (result.success) {
        setStatus({ installed: false, runtimeDir: '' })
        setDrawers([])
        setTotalDrawers(0)
        setInstallPhase('idle')
        return true
      }
      setInstallPhase('idle')
      return false
    } catch {
      setInstallPhase('idle')
      return false
    }
  }, [])

  return {
    // 安装相关
    status,
    isLoading,
    installPhase,
    installProgress,
    installError,
    install,
    refresh,
    // 列表
    drawers,
    totalDrawers,
    listLoading,
    listError,
    currentPage,
    pageSize: PAGE_SIZE,
    listDrawers,
    // 搜索
    searchResults,
    searchLoading,
    searchQuery,
    isSearchMode,
    searchDrawers,
    setSearchQuery,
    exitSearch,
    // 删除/清空
    deleteLoading,
    deleteDrawer,
    clearLoading,
    clearProgress,
    clearAllDrawers,
    uninstall,
  }
}
