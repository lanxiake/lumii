/**
 * useAsync Hook - 异步操作状态管理
 *
 * 管理异步操作的 loading、error、data 状态
 * 支持自动清理和手动重试
 */

import { useState, useCallback, useRef, useEffect } from 'react'

/**
 * useAsync 配置选项
 */
export interface UseAsyncOptions<T> {
  /** 初始数据 */
  initialData?: T
  /** 错误时是否自动重置数据 */
  resetOnError?: boolean
  /** 成功回调 */
  onSuccess?: (data: T) => void
  /** 错误回调 */
  onError?: (error: Error) => void
}

/**
 * useAsync 返回值
 */
export interface UseAsyncReturn<T> {
  /** 数据 */
  data: T | null
  /** 是否正在加载 */
  isLoading: boolean
  /** 错误信息 */
  error: Error | null
  /** 执行异步操作，silent 模式不触发 isLoading（用于后台刷新） */
  execute: (asyncFunction: () => Promise<T>, options?: { silent?: boolean }) => Promise<T>
  /** 重置状态 */
  reset: () => void
  /** 重试上次操作 */
  retry: () => Promise<T | null>
  /** 手动设置错误 */
  setError: (error: Error | null) => void
}

/**
 * 异步操作 Hook
 *
 * @example
 * const { data, isLoading, error, execute } = useAsync()
 * // 执行
 * await execute(async () => fetchUserData(userId))
 */
export function useAsync<T>(
  options: UseAsyncOptions<T> = {}
): UseAsyncReturn<T> {
  const { initialData = null, resetOnError = false, onSuccess, onError } = options

  const [data, setData] = useState<T | null>(initialData)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  // 保存上次执行的函数用于重试
  const lastFunctionRef = useRef<(() => Promise<T>) | null>(null)
  // 使用 AbortController 来取消进行中的请求
  const abortControllerRef = useRef<AbortController | null>(null)
  // 标记当前请求 ID，用于判断是否是当前请求
  const requestIdRef = useRef<number>(0)

  // 用 ref 稳定回调，避免 execute 因回调引用变化而频繁重建
  const onSuccessRef = useRef(onSuccess)
  const onErrorRef = useRef(onError)
  const resetOnErrorRef = useRef(resetOnError)
  useEffect(() => { onSuccessRef.current = onSuccess }, [onSuccess])
  useEffect(() => { onErrorRef.current = onError }, [onError])
  useEffect(() => { resetOnErrorRef.current = resetOnError }, [resetOnError])

  const execute = useCallback(
    async (asyncFunction: () => Promise<T>, options?: { silent?: boolean }): Promise<T> => {
      // 生成新的请求 ID
      const currentRequestId = ++requestIdRef.current

      if (!options?.silent) {
        setIsLoading(true)
      }
      setError(null)
      lastFunctionRef.current = asyncFunction

      try {
        const result = await asyncFunction()
        
        // 检查是否还是当前请求（防止过期请求更新状态）
        if (currentRequestId === requestIdRef.current) {
          setData(result)
          setIsLoading(false)
          onSuccessRef.current?.(result)
        }
        
        return result
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err))
        
        // 检查是否还是当前请求
        if (currentRequestId === requestIdRef.current) {
          setError(error)
          setIsLoading(false)
          if (resetOnErrorRef.current) {
            setData(null)
          }
          onErrorRef.current?.(error)
        }
        
        throw error
      }
    },
    [] // 依赖为空，execute 引用永远稳定
  )

  const reset = useCallback(() => {
    setData(initialData)
    setError(null)
    setIsLoading(false)
    lastFunctionRef.current = null
  }, [initialData])

  const retry = useCallback(async (): Promise<T | null> => {
    if (lastFunctionRef.current) {
      return execute(lastFunctionRef.current)
    }
    return null
  }, [execute])
  
  const setErrorManual = useCallback((err: Error | null) => {
    setError(err)
  }, [])

  return {
    data,
    isLoading,
    error,
    execute,
    reset,
    retry,
    setError: setErrorManual,
  }
}
