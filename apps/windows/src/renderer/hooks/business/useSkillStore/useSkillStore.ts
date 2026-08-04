/**
 * useSkillStore Hook - 技能商店
 *
 * 管理技能商店的浏览、搜索、安装等功能
 * 通过 API Server REST API 与后端交互
 */

import { useState, useCallback, useRef } from 'react'

/**
 * 将技能名称/目录名规范为可比较的关键字（弱化空格、连字符、下划线等差异）
 */
function looseSkillKey(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_\-/\\.]+/g, '')
}

/**
 * 根据本地已安装列表构建用于与商店技能匹配的 id 与名称查找表
 */
function buildInstalledLookup(
  local: Array<{ id?: string; name: string; dirName?: string }>,
): { ids: Set<string>; keys: Set<string> } {
  const ids = new Set<string>()
  const keys = new Set<string>()
  for (const s of local) {
    const id = s.id?.trim()
    if (id) {
      ids.add(id)
    }
    if (s.name?.trim()) {
      keys.add(looseSkillKey(s.name))
    }
    if (s.dirName?.trim()) {
      keys.add(looseSkillKey(s.dirName))
    }
  }
  return { ids, keys }
}

/**
 * 判断商店列表中的某项是否已在本地安装（优先 id，其次名称/目录名宽松匹配）
 */
function isStoreSkillInstalled(
  skill: StoreSkillInfo,
  lookup: ReturnType<typeof buildInstalledLookup>,
): boolean {
  if (skill.id && lookup.ids.has(skill.id)) {
    return true
  }
  return lookup.keys.has(looseSkillKey(skill.name))
}

/**
 * 规范化 IPC 返回的本地已安装技能数组
 */
function normalizeLocalInstalledRaw(raw: unknown): Array<{ id?: string; name: string; dirName?: string }> {
  const arr: unknown[] = Array.isArray(raw) ? raw : ((raw as { data?: unknown[] })?.data ?? [])
  return arr
    .map((item) => {
      const s = item as { id?: string; name?: string; dirName?: string }
      return {
        id: typeof s.id === 'string' ? s.id : undefined,
        name: typeof s.name === 'string' ? s.name : '',
        dirName: typeof s.dirName === 'string' ? s.dirName : undefined,
      }
    })
    .filter((s) => s.name.length > 0)
}

/**
 * 商店技能信息
 */
export interface StoreSkillInfo {
  /** 技能 ID */
  id: string
  /** 技能名称 */
  name: string
  /** 技能描述 */
  description: string
  /** 详细描述 */
  longDescription?: string
  /** 版本 */
  version: string
  /** 作者 */
  author: string
  /** 图标 */
  icon?: string
  /** 分类 */
  category: string
  /** 标签 */
  tags: string[]
  /** 运行模式 */
  runMode: 'server' | 'local' | 'hybrid'
  /** 订阅要求 */
  subscription: {
    type: 'free' | 'premium' | 'enterprise'
    price?: number
    period?: 'monthly' | 'yearly' | 'once'
  }
  /** 下载次数 */
  downloads: number
  /** 评分 */
  rating: number
  /** 评分人数 */
  ratingCount: number
  /** 更新时间 */
  updatedAt: string
  /** 截图 */
  screenshots?: string[]
  /** 源 URL */
  sourceUrl?: string
  /** 是否已安装 */
  installed?: boolean
  /** 安装的版本 */
  installedVersion?: string
  /** 是否有可用更新 */
  hasUpdate?: boolean
  /** 商店推荐位（用于卡片标注与排序） */
  isFeatured?: boolean
  /** 商店热门列表（用于卡片标注与排序） */
  isPopular?: boolean
}

/**
 * 技能卡片展示的短描述：优先接口短字段，否则从长文/Markdown 摘一行
 */
export function pickStoreSkillCardDescription(skill: StoreSkillInfo): string {
  const short = skill.description?.trim()
  if (short) {
    return short
  }
  const long = skill.longDescription?.trim()
  if (!long) {
    return '暂无描述'
  }
  const stripped = long.replace(/^---[\s\S]*?---\s*/m, '').trim()
  const plain = stripped
    .replace(/^#+\s+[^\n]*\n?/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n+/g, ' ')
    .trim()
  const oneLine = plain.slice(0, 220)
  return oneLine.length < plain.length ? `${oneLine}…` : oneLine
}

/**
 * 技能详情弹窗正文：优先长描述，否则短描述
 */
export function pickStoreSkillDetailText(skill: StoreSkillInfo): string {
  const long = skill.longDescription?.trim()
  if (long) {
    return long
  }
  return skill.description?.trim() || '暂无描述'
}

/**
 * 按商店「推荐 → 热门 → 其余按下载量」排序当前页中的技能
 */
function sortSkillsByFeaturedPopularOrder(
  list: StoreSkillInfo[],
  featuredOrder: Map<string, number>,
  popularOrder: Map<string, number>,
): StoreSkillInfo[] {
  return [...list].sort((a, b) => {
    const fa = featuredOrder.get(a.id)
    const fb = featuredOrder.get(b.id)
    if (fa !== undefined && fb !== undefined) {
      return fa - fb
    }
    if (fa !== undefined) {
      return -1
    }
    if (fb !== undefined) {
      return 1
    }
    const pa = popularOrder.get(a.id)
    const pb = popularOrder.get(b.id)
    if (pa !== undefined && pb !== undefined) {
      return pa - pb
    }
    if (pa !== undefined) {
      return -1
    }
    if (pb !== undefined) {
      return 1
    }
    return b.downloads - a.downloads
  })
}

/**
 * 为技能打上推荐/热门标记（与后端列表 ID 对应）
 */
function applyFeaturedPopularFlags(
  list: StoreSkillInfo[],
  featuredOrder: Map<string, number>,
  popularOrder: Map<string, number>,
): StoreSkillInfo[] {
  return list.map((s) => ({
    ...s,
    isFeatured: featuredOrder.has(s.id),
    isPopular: popularOrder.has(s.id),
  }))
}

/**
 * 技能分类信息
 */
export interface SkillCategory {
  id: string
  name: string
  icon: string
  count: number
}

/**
 * 商店筛选条件
 */
export interface StoreFilters {
  category?: string
  tags?: string[]
  subscription?: 'free' | 'premium' | 'enterprise' | 'all'
  sortBy?: 'downloads' | 'rating' | 'updated' | 'name'
  search?: string
}

/**
 * 商店统计信息
 */
export interface StoreStats {
  totalSkills: number
  totalDownloads: number
  categories: SkillCategory[]
  popularTags: string[]
}

/**
 * 技能上传数据
 */
export interface SkillUploadData {
  /** 技能名称 */
  name: string
  /** 技能描述 */
  description: string
  /** 详细说明 (Markdown) */
  readme?: string
  /** 版本号 */
  version: string
  /** 分类 ID */
  categoryId?: string
  /** 标签列表 */
  tags?: string[]
  /** 订阅级别要求 */
  subscriptionLevel?: 'free' | 'monthly' | 'yearly'
  /** 图标 URL */
  iconUrl?: string
  /** 技能配置文件 URL */
  manifestUrl?: string
  /** 技能包下载 URL */
  packageUrl?: string
  /** 技能配置 (JSON) */
  config?: Record<string, unknown>
}

interface UseSkillStoreReturn {
  /** 商店技能列表 */
  skills: StoreSkillInfo[]
  /** 商店统计 */
  stats: StoreStats | null
  /** 分类列表 */
  categories: SkillCategory[]
  /** 是否正在加载 */
  isLoading: boolean
  /** 是否正在加载更多（分页追加，不影响列表显示） */
  isLoadingMore: boolean
  /** 是否正在上传 */
  isUploading: boolean
  /** 错误信息 */
  error: string | null
  /** 当前筛选条件 */
  filters: StoreFilters
  /** 是否有更多数据可加载 */
  hasMore: boolean
  /** 是否正在刷新商店 */
  isRefreshing: boolean

  /** 加载商店技能列表 */
  loadStoreSkills: (filters?: StoreFilters) => Promise<void>
  /** 加载更多技能（分页） */
  loadMore: () => Promise<void>
  /** 加载商店统计 */
  loadStats: () => Promise<void>
  /** 加载分类列表 */
  loadCategories: () => Promise<void>
  /** 搜索技能 */
  searchSkills: (query: string) => Promise<void>
  /** 更新部分筛选条件并重新加载 */
  updateFilters: (partial: Partial<StoreFilters>) => Promise<void>
  /** 设置筛选条件 */
  setFilters: (filters: StoreFilters) => void
  /** 获取技能详情 */
  getSkillDetail: (skillId: string) => Promise<StoreSkillInfo | null>
  /** 安装技能（下载并解压到本地） */
  installSkill: (skillId: string) => Promise<{ success: boolean; error?: string }>
  /** 上传技能 */
  uploadSkill: (
    data: SkillUploadData,
  ) => Promise<{ success: boolean; skillId?: string; error?: string }>
  /** 刷新商店 */
  refreshStore: () => Promise<void>
  /** 仅重新检测本地安装状态，不重新请求商店接口 */
  refreshInstallStatus: () => Promise<void>
}

/**
 * 技能商店 Hook
 */
export function useSkillStore(): UseSkillStoreReturn {
  const [skills, setSkills] = useState<StoreSkillInfo[]>([])
  const [stats, setStats] = useState<StoreStats | null>(null)
  const [categories, setCategories] = useState<SkillCategory[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filters, setFilters] = useState<StoreFilters>({})
  const filtersRef = useRef<StoreFilters>({})
  const [hasMore, setHasMore] = useState(false)
  const [currentOffset, setCurrentOffset] = useState(0)
  const currentOffsetRef = useRef(0)

  /** 每页加载数量 */
  const PAGE_SIZE = 20

  /** 与 loadStoreSkills 同步的推荐/热门顺序，供 loadMore 合并列表时排序与打标 */
  const featuredOrderRef = useRef<Map<string, number>>(new Map())
  const popularOrderRef = useRef<Map<string, number>>(new Map())

  /**
   * 为商店技能列表打上本地「已安装」标记（id / 名称 / 目录名多重匹配）
   * @param localRaw 若已从并行请求取得 listLocalInstalled 结果可传入，避免重复 IPC
   */
  const applyLocalInstallFlags = useCallback(
    async (list: StoreSkillInfo[], localRaw?: unknown): Promise<StoreSkillInfo[]> => {
      const raw = localRaw ?? (await window.electronAPI.skills.listLocalInstalled())
      const localEntries = normalizeLocalInstalledRaw(raw)
      const lookup = buildInstalledLookup(localEntries)
      return list.map((skill) => ({
        ...skill,
        installed: isStoreSkillInstalled(skill, lookup),
      }))
    },
    [],
  )

  /**
   * 加载商店技能列表
   */
  const loadStoreSkills = useCallback(
    async (newFilters?: StoreFilters) => {
      console.log('[useSkillStore] 加载商店技能列表', newFilters)
      setIsLoading(true)
      setError(null)

      const currentFilters = newFilters ?? filtersRef.current
      if (newFilters) {
        filtersRef.current = newFilters
        setFilters(newFilters)
      }

      try {
        // 并行：商店列表、本地已安装、推荐 ID 列表、热门 ID 列表
        const [storeResult, localSkills, featResult, popResult] = await Promise.all([
          window.electronAPI.api.getStoreSkills({
            category: currentFilters.category,
            subscription: currentFilters.subscription,
            sortBy: currentFilters.sortBy,
            search: currentFilters.search,
            tags: currentFilters.tags,
            offset: 0,
            limit: PAGE_SIZE,
          }) as Promise<{
            success: boolean
            data?: StoreSkillInfo[]
            meta?: { total: number; hasMore?: boolean }
            error?: string
          }>,
          window.electronAPI.skills.listLocalInstalled(),
          window.electronAPI.api.getStoreFeatured(200) as Promise<{
            success: boolean
            data?: StoreSkillInfo[]
          }>,
          window.electronAPI.api.getStorePopular(200) as Promise<{
            success: boolean
            data?: StoreSkillInfo[]
          }>,
        ])

        const featuredOrder = new Map(
          (featResult.success && featResult.data ? featResult.data : []).map((s, i) => [s.id, i]),
        )
        const popularOrder = new Map(
          (popResult.success && popResult.data ? popResult.data : []).map((s, i) => [s.id, i]),
        )
        featuredOrderRef.current = featuredOrder
        popularOrderRef.current = popularOrder

        if (storeResult.success && storeResult.data) {
          const flagged = await applyLocalInstallFlags(storeResult.data, localSkills)
          const tagged = applyFeaturedPopularFlags(flagged, featuredOrder, popularOrder)
          const skillsWithInstallStatus = sortSkillsByFeaturedPopularOrder(tagged, featuredOrder, popularOrder)

          setSkills(skillsWithInstallStatus)
          currentOffsetRef.current = skillsWithInstallStatus.length
          setCurrentOffset(skillsWithInstallStatus.length)
          const total = storeResult.meta?.total ?? skillsWithInstallStatus.length
          setHasMore(storeResult.meta?.hasMore ?? skillsWithInstallStatus.length < total)
        } else {
          console.error('[useSkillStore] 加载失败:', storeResult.error)
          setError(storeResult.error || '加载商店失败')
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : '加载商店失败'
        console.error('[useSkillStore] 加载失败:', errorMessage)
        setError(errorMessage)
      } finally {
        setIsLoading(false)
      }
    },
    [applyLocalInstallFlags],
  )

  /**
   * 加载更多技能（分页追加）
   */
  const loadMore = useCallback(async () => {
    if (isLoading || isLoadingMore || !hasMore) return

    const offset = currentOffsetRef.current
    const f = filtersRef.current
    console.log('[useSkillStore] 加载更多技能, offset:', offset)
    setIsLoadingMore(true)

    try {
      const [result, localRaw] = await Promise.all([
        window.electronAPI.api.getStoreSkills({
          category: f.category,
          subscription: f.subscription,
          sortBy: f.sortBy,
          search: f.search,
          tags: f.tags,
          offset,
          limit: PAGE_SIZE,
        }) as Promise<{
          success: boolean
          data?: StoreSkillInfo[]
          meta?: { total: number; hasMore?: boolean }
          error?: string
        }>,
        window.electronAPI.skills.listLocalInstalled(),
      ])

      if (result.success && result.data) {
        const chunk = result.data
        const merged = await applyLocalInstallFlags(chunk, localRaw)
        setSkills((prev) => {
          const existingIds = new Set(prev.map((s) => s.id))
          const deduped = merged.filter((s) => !existingIds.has(s.id))
          const tagged = applyFeaturedPopularFlags(
            deduped,
            featuredOrderRef.current,
            popularOrderRef.current,
          )
          return [...prev, ...tagged]
        })
        const newOffset = offset + chunk.length
        currentOffsetRef.current = newOffset
        setCurrentOffset(newOffset)
        const total = result.meta?.total ?? 0
        setHasMore(result.meta?.hasMore ?? newOffset < total)
        console.log('[useSkillStore] 追加加载成功，新增', chunk.length, '个技能')
      }
    } catch (err) {
      console.error('[useSkillStore] 加载更多失败:', err)
    } finally {
      setIsLoadingMore(false)
    }
  }, [isLoading, isLoadingMore, hasMore, applyLocalInstallFlags])

  /**
   * 加载商店统计
   */
  const loadStats = useCallback(async () => {
    console.log('[useSkillStore] 加载商店统计')
    try {
      const result = (await window.electronAPI.api.getStoreStats()) as {
        success: boolean
        data?: StoreStats
        error?: string
      }

      if (result.success && result.data) {
        setStats(result.data)
      }
    } catch (err) {
      console.error('[useSkillStore] 加载统计失败:', err)
    }
  }, [])

  /**
   * 加载分类列表（与 Admin Console 同源：GET /api/store/categories → getCategoryList）
   */
  const loadCategories = useCallback(async () => {
    console.log('[useSkillStore] 加载分类列表')
    try {
      const result = (await window.electronAPI.api.getStoreCategories()) as {
        success: boolean
        data?:
          | Array<{
              id: string
              name: string
              icon: string | null
              skillCount: number
            }>
          | {
              items: Array<{
                id: string
                name: string
                icon: string | null
                skillCount: number
              }>
              total: number
            }
        error?: string
      }

      if (!result.success || !result.data) {
        return
      }

      const rows = Array.isArray(result.data)
        ? result.data
        : result.data.items

      const mappedCategories: SkillCategory[] = rows.map((item) => ({
        id: item.id,
        name: item.name,
        icon: item.icon || '📦',
        count: item.skillCount || 0,
      }))

      setCategories(mappedCategories)
    } catch (err) {
      console.error('[useSkillStore] 加载分类失败:', err)
    }
  }, [])

  /**
   * 搜索技能
   */
  const searchSkills = useCallback(
    async (query: string) => {
      console.log('[useSkillStore] 搜索技能:', query)
      await loadStoreSkills({ ...filtersRef.current, search: query })
    },
    [loadStoreSkills],
  )

  /**
   * 更新部分筛选条件并重新加载（自动合并当前 filtersRef）
   */
  const updateFilters = useCallback(
    async (partial: Partial<StoreFilters>) => {
      await loadStoreSkills({ ...filtersRef.current, ...partial })
    },
    [loadStoreSkills],
  )

  /**
   * 获取技能详情
   */
  const getSkillDetail = useCallback(
    async (skillId: string): Promise<StoreSkillInfo | null> => {
      console.log('[useSkillStore] 获取技能详情:', skillId)
      try {
        const result = (await window.electronAPI.api.getStoreSkillDetail(skillId)) as {
          success: boolean
          data?: StoreSkillInfo
          error?: string
        }

        if (result.success && result.data) {
          return result.data
        }
        return null
      } catch (err) {
        console.error('[useSkillStore] 获取详情失败:', err)
        return null
      }
    },
    [],
  )

  /**
   * 安装技能（下载并解压到本地 workspace/skills/）
   */
  const installSkill = useCallback(
    async (skillId: string): Promise<{ success: boolean; error?: string }> => {
      console.log('[useSkillStore] 安装技能:', skillId)
      try {
        const result = (await window.electronAPI.api.installStoreSkill(skillId)) as {
          success: boolean
          data?: { skillId: string; dirName?: string }
          error?: string
        }

        return { success: result.success, error: result.error }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : '安装失败'
        console.error('[useSkillStore] 安装失败:', errorMessage)
        return { success: false, error: errorMessage }
      }
    },
    [],
  )

  /**
   * 上传技能（创建用户自建技能）
   */
  const uploadSkill = useCallback(
    async (
      data: SkillUploadData,
    ): Promise<{ success: boolean; skillId?: string; error?: string }> => {
      console.log('[useSkillStore] 上传技能:', data.name)
      setIsUploading(true)
      setError(null)

      try {
        // 通过 REST API 创建用户自建技能
        const result = (await window.electronAPI.api.createUserSkill({
          name: data.name,
          description: data.description,
          version: data.version,
        })) as {
          success: boolean
          data?: { id: string; name: string; status: string }
          error?: string
        }

        if (result.success && result.data?.id) {
          console.log('[useSkillStore] 技能创建成功, skillId:', result.data.id)
          // 刷新商店列表
          await loadStoreSkills()
          return { success: true, skillId: result.data.id }
        } else {
          const errorMessage = result.error || '创建技能失败'
          console.error('[useSkillStore] 创建失败:', errorMessage)
          setError(errorMessage)
          return { success: false, error: errorMessage }
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : '上传失败'
        console.error('[useSkillStore] 上传异常:', errorMessage)
        setError(errorMessage)
        return { success: false, error: errorMessage }
      } finally {
        setIsUploading(false)
      }
    },
    [loadStoreSkills],
  )

  /**
   * 刷新商店
   */
  const refreshStore = useCallback(async () => {
    console.log('[useSkillStore] 刷新商店')
    setIsRefreshing(true)
    try {
      await window.electronAPI.api.refreshStore()
      await Promise.all([loadStoreSkills(), loadStats(), loadCategories()])
    } catch (err) {
      console.error('[useSkillStore] 刷新商店失败:', err)
    } finally {
      setIsRefreshing(false)
    }
  }, [loadStoreSkills, loadStats, loadCategories])

  /**
   * 仅重新检测本地安装状态，不重新请求商店接口
   * 在切换已安装/未安装过滤器时调用，确保 installed 标记与本地实际状态一致
   */
  const refreshInstallStatus = useCallback(async () => {
    try {
      const localRaw = await window.electronAPI.skills.listLocalInstalled()
      const localEntries = normalizeLocalInstalledRaw(localRaw)
      const lookup = buildInstalledLookup(localEntries)
      setSkills(prev => prev.map(skill => ({
        ...skill,
        installed: isStoreSkillInstalled(skill, lookup),
      })))
    } catch (err) {
      console.error('[useSkillStore] refreshInstallStatus 失败:', err)
    }
  }, [])

  return {
    // 状态
    skills,
    stats,
    categories,
    isLoading,
    isLoadingMore,
    isUploading,
    isRefreshing,
    error,
    filters,
    hasMore,

    // 方法
    loadStoreSkills,
    loadMore,
    loadStats,
    loadCategories,
    searchSkills,
    updateFilters,
    setFilters,
    getSkillDetail,
    installSkill,
    uploadSkill,
    refreshStore,
    refreshInstallStatus,
  }
}
