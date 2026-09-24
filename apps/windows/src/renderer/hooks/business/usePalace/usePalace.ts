/**
 * 记忆宫殿数据钩子（自研 SQLite 版）
 *
 * 与旧的 `useMemPalace` 的差别：
 * - **没有安装态**：后端就是应用自己的 SQLite，没有 install/uninstall/progress 那套状态机。
 *   `available` 只表示"库打开了没有"，UI 据此显示"暂不可用"，而不是引导去装插件。
 * - **搜索结果是摘录**（`PalaceRepo` 有意不返回全文：段原文平均 6790 字符、最长 94473，
 *   整段塞进列表会把渲染卡住）。要看全文走 `read`。
 * - **`score` 不是 `similarity`**：后端返回的是 `-bm25` 相关性分数，无上界、不可跨查询比较。
 *   这里不做 [0,1] 的假归一——那会让"80% 相似"这种数字失去意义。展示层只按相对高低
 *   给个视觉区分（见 viewer 里的 `renderScore`）。
 */

import { useState, useEffect, useCallback } from 'react'

export interface PalaceListItem {
  drawer_id: string
  wing: string
  room: string
  agent_id: string
  conversation_id: string | null
  char_count: number
  created_at: string
  /** 会话标题（IPC 层取回；取不到时缺省） */
  conversationTitle?: string
  /** 会话渠道（local / feishu / weixin / qbot / wecom / cron） */
  channelType?: string | null
}

export interface PalaceSearchItem {
  drawer_id: string
  text: string
  wing: string
  room: string
  /** `-bm25`：越大越相关，无上界 */
  score: number
  created_at: string
  char_count: number
  truncated: boolean
  /** 命中的归档所属会话标题（room 恰为会话 id 时才有） */
  conversationTitle?: string
  channelType?: string | null
}

export interface PalaceCounts {
  active: number
  tombstoned: number
  total: number
}

const PALACE_PAGE_SIZE = 20

export function usePalace() {
  const [available, setAvailable] = useState(true)
  const [counts, setCounts] = useState<PalaceCounts | null>(null)
  const [wings, setWings] = useState<Array<{ wing: string; count: number }>>([])

  // 列表状态
  const [items, setItems] = useState<PalaceListItem[]>([])
  const [total, setTotal] = useState(0)
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [currentPage, setCurrentPage] = useState(0)
  const [wingFilter, setWingFilter] = useState<string | null>(null)

  // 搜索状态
  const [searchResults, setSearchResults] = useState<PalaceSearchItem[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [isSearchMode, setIsSearchMode] = useState(false)

  // 删除/清空
  const [deleteLoading, setDeleteLoading] = useState<string | null>(null)
  const [clearLoading, setClearLoading] = useState(false)

  const refreshStatus = useCallback(async () => {
    try {
      const res = await window.electronAPI.palace.getStatus()
      setAvailable(res.available)
      setCounts(res.counts)
      setWings(res.wings ?? [])
      if (res.error) setListError(res.error)
    } catch (err) {
      setAvailable(false)
      setListError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const loadPage = useCallback(
    async (page: number, wing: string | null = wingFilter) => {
      setListLoading(true)
      setListError(null)
      try {
        const res = await window.electronAPI.palace.list({
          limit: PALACE_PAGE_SIZE,
          offset: page * PALACE_PAGE_SIZE,
          ...(wing ? { wing } : {}),
        })
        setAvailable(res.available)
        if (res.error) {
          setListError(res.error)
        } else {
          setItems(res.items)
          setTotal(res.total)
          setCurrentPage(page)
        }
      } catch (err) {
        setListError(err instanceof Error ? err.message : String(err))
      } finally {
        setListLoading(false)
      }
    },
    [wingFilter],
  )

  /** 切换 wing 过滤（同时回到第一页，否则会停在一个空页上） */
  const selectWing = useCallback(
    (wing: string | null) => {
      setWingFilter(wing)
      void loadPage(0, wing)
    },
    [loadPage],
  )

  const search = useCallback(async (query: string) => {
    setSearchLoading(true)
    setListError(null)
    try {
      const res = await window.electronAPI.palace.search({ query, limit: 30 })
      setAvailable(res.available)
      if (res.error) {
        setListError(res.error)
      } else {
        setSearchResults(res.results)
        setSearchQuery(query)
        setIsSearchMode(true)
      }
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

  /** 读取全文（列表/搜索结果都只给摘录，点开才取） */
  const readDrawer = useCallback(async (drawerId: string) => {
    const res = await window.electronAPI.palace.read(drawerId)
    return res.detail
  }, [])

  const deleteDrawer = useCallback(
    async (drawerId: string) => {
      setDeleteLoading(drawerId)
      try {
        const res = await window.electronAPI.palace.delete(drawerId)
        if (res.success) {
          // 从两个列表里都摘掉，不重拉整页（删除是墓碑，总数会变）
          setItems((prev) => prev.filter((d) => d.drawer_id !== drawerId))
          setSearchResults((prev) => prev.filter((d) => d.drawer_id !== drawerId))
          setTotal((t) => Math.max(0, t - 1))
          void refreshStatus()
        } else if (res.error && res.error !== 'unavailable') {
          setListError(res.error)
        }
        return res.success
      } catch (err) {
        setListError(err instanceof Error ? err.message : String(err))
        return false
      } finally {
        setDeleteLoading(null)
      }
    },
    [refreshStatus],
  )

  const clearAllDrawers = useCallback(async () => {
    setClearLoading(true)
    try {
      const res = await window.electronAPI.palace.clear()
      if (res.success) {
        setItems([])
        setSearchResults([])
        setTotal(0)
        setCurrentPage(0)
        setIsSearchMode(false)
        void refreshStatus()
      } else if (res.error && res.error !== 'unavailable') {
        setListError(res.error)
      }
      return res.success
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setClearLoading(false)
    }
  }, [refreshStatus])

  // 首次挂载：拉状态 + 第一页
  useEffect(() => {
    void refreshStatus()
    void loadPage(0, null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    available,
    counts,
    wings,
    wingFilter,
    selectWing,
    items,
    total,
    listLoading,
    listError,
    currentPage,
    pageSize: PALACE_PAGE_SIZE,
    loadPage,
    searchResults,
    searchLoading,
    searchQuery,
    isSearchMode,
    search,
    exitSearch,
    readDrawer,
    deleteLoading,
    deleteDrawer,
    clearLoading,
    clearAllDrawers,
    refreshStatus,
  }
}
