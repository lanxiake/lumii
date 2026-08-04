/**
 * useQuery Hook - 数据查询管理
 *
 * 基于 useAsync 封装，支持缓存、轮询、条件执行等特性
 * 适用于从服务器获取数据的场景
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { useAsync } from '../useAsync'

/**
 * useQuery 配置选项（对象参数风格）
 */
export interface UseQueryOptionsObject<T> {
  /** 查询键，用于缓存和重验证 */
  queryKey: string | unknown[]
  /** 查询函数 */
  queryFn: () => Promise<T>
  /** 是否立即执行 */
  enabled?: boolean
  /** 刷新间隔（毫秒），0 表示不刷新 */
  refetchInterval?: number
  /** 窗口重新获得焦点时是否刷新 */
  refetchOnWindowFocus?: boolean
  /** 错误重试次数 */
  retryCount?: number
  /** 重试延迟（毫秒） */
  retryDelay?: number
  /** 成功回调 */
  onSuccess?: (data: T) => void
  /** 错误回调 */
  onError?: (error: Error) => void
}

/**
 * useQuery 返回值
 */
/** @deprecated 与通用导出 `UseQueryOptions` 同义 */
export type UseQueryOptions<T> = UseQueryOptionsObject<T>

export interface UseQueryReturn<T> {
  /** 数据 */
  data: T | null
  /** 是否正在加载 */
  isLoading: boolean
  /** 是否正在后台刷新 */
  isRefetching: boolean
  /** 错误信息 */
  error: Error | null
  /** 手动刷新 */
  refetch: () => Promise<T>
  /** 重置状态 */
  reset: () => void
}

// 简单的内存缓存
const queryCache = new Map<string, { data: unknown; timestamp: number }>()
const CACHE_TTL = 5 * 60 * 1000 // 5分钟缓存

/**
 * 数据查询 Hook（对象参数风格，类似 React Query）
 *
 * @example
 * const { data, isLoading, refetch } = useQuery({
 *   queryKey: ['users', userId],
 *   queryFn: () => fetchUser(userId),
 *   enabled: !!userId
 * })
 */
export function useQuery<T>(
  options: UseQueryOptionsObject<T>
): UseQueryReturn<T> {
  const {
    queryKey,
    queryFn,
    enabled = true,
    refetchInterval = 0,
    refetchOnWindowFocus = false,
    retryCount = 3,
    retryDelay = 1000,
    onSuccess,
    onError,
  } = options

  // 将 queryKey 转换为字符串
  const queryKeyString = Array.isArray(queryKey) 
    ? queryKey.filter(k => k != null).join(':')
    : String(queryKey)

  const [isRefetching, setIsRefetching] = useState(false)
  const retryCountRef = useRef(0)
  const intervalRef = useRef<NodeJS.Timeout | null>(null)

  // 检查缓存
  const cachedData = queryCache.get(queryKeyString)
  const initialData = cachedData && Date.now() - cachedData.timestamp < CACHE_TTL
    ? (cachedData.data as T)
    : undefined

  // 用 ref 稳定 queryFn / onSuccess / onError，避免它们的引用变化导致 refetch 重建
  const queryFnRef = useRef(queryFn)
  const onSuccessRef = useRef(onSuccess)
  const onErrorRef = useRef(onError)
  const queryKeyStringRef = useRef(queryKeyString)
  useEffect(() => { queryFnRef.current = queryFn }, [queryFn])
  useEffect(() => { onSuccessRef.current = onSuccess }, [onSuccess])
  useEffect(() => { onErrorRef.current = onError }, [onError])
  useEffect(() => { queryKeyStringRef.current = queryKeyString }, [queryKeyString])

  const { data, isLoading, error, execute, reset } = useAsync<T>({
    initialData,
    onSuccess: (result) => {
      // 更新缓存
      queryCache.set(queryKeyStringRef.current, { data: result, timestamp: Date.now() })
      retryCountRef.current = 0
      onSuccessRef.current?.(result)
    },
    onError: (err) => {
      onErrorRef.current?.(err)
    },
  })

  // refetch 只依赖 execute（永远稳定），通过 ref 读取最新 queryFn
  const refetch = useCallback(async (): Promise<T> => {
    setIsRefetching(true)
    try {
      const result = await execute(queryFnRef.current)
      return result
    } finally {
      setIsRefetching(false)
    }
  }, [execute])

  // 初始加载 - 当 enabled 变为 true 且还没加载过且缓存无效时执行
  // 使用 undefined 作为初始值来区分首次渲染和后续渲染
  const prevEnabledRef = useRef<boolean | undefined>(undefined)
  // 标记是否已经发起过初始加载
  const hasInitialLoadRef = useRef<boolean>(false)
  const refetchRef = useRef(refetch)
  useEffect(() => { refetchRef.current = refetch }, [refetch])
  useEffect(() => {
    // 只在首次渲染且 enabled=true 时触发加载
    if (enabled && !hasInitialLoadRef.current && prevEnabledRef.current === undefined) {
      hasInitialLoadRef.current = true
      refetchRef.current()
    }

    // 当 enabled 从 false 变为 true 时触发加载（处理异步认证完成后的场景）
    if (enabled && prevEnabledRef.current === false) {
      refetchRef.current()
    }

    // 更新 prevEnabledRef 以追踪状态变化
    prevEnabledRef.current = enabled
  }, [enabled])

  // 静默刷新（后台轮询专用，不触发 isLoading 闪动）
  const silentRefetch = useCallback(async (): Promise<void> => {
    try {
      await execute(queryFnRef.current, { silent: true })
    } catch {
      // 轮询失败静默忽略
    }
  }, [execute])

  // 轮询
  useEffect(() => {
    if (refetchInterval > 0 && enabled) {
      intervalRef.current = setInterval(() => {
        void silentRefetch()
      }, refetchInterval)

      return () => {
        if (intervalRef.current) {
          clearInterval(intervalRef.current)
        }
      }
    }
  }, [refetchInterval, enabled, silentRefetch])

  // 窗口焦点刷新
  useEffect(() => {
    if (refetchOnWindowFocus && enabled) {
      const handleFocus = () => refetch()
      window.addEventListener('focus', handleFocus)
      return () => window.removeEventListener('focus', handleFocus)
    }
  }, [refetchOnWindowFocus, enabled, refetch])

  return {
    data,
    isLoading,
    isRefetching,
    error,
    refetch,
    reset,
  }
}

/**
 * 清除查询缓存
 */
export function clearQueryCache(queryKey?: string): void {
  if (queryKey) {
    queryCache.delete(queryKey)
  } else {
    queryCache.clear()
  }
}

/**
 * 使指定查询失效（清除缓存）
 */
export function invalidateQuery(queryKey: string): void {
  queryCache.delete(queryKey)
}
