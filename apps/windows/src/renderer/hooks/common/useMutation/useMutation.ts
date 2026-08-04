/**
 * useMutation Hook - 数据变更操作
 *
 * 用于创建、更新、删除等变更操作
 * 支持乐观更新和错误回滚
 */

import { useState, useCallback, useRef } from 'react'
import { useAsync } from '../useAsync'

/**
 * useMutation 配置选项
 */
export interface UseMutationOptions<T, P extends unknown[] = unknown[]> {
  /** 乐观更新函数 */
  optimisticUpdate?: (...params: P) => void
  /** 回滚函数 */
  rollback?: () => void
  /** 成功回调 */
  onSuccess?: (data: T, ...params: P) => void
  /** 错误回调 */
  onError?: (error: Error, ...params: P) => void
  /** 完成回调（无论成功或失败） */
  onSettled?: (data: T | null, error: Error | null, ...params: P) => void
}

/**
 * useMutation 返回值
 */
export interface UseMutationReturn<T, P extends unknown[] = unknown[]> {
  /** 变更结果数据 */
  data: T | null
  /** 是否正在执行 */
  isLoading: boolean
  /** 错误信息 */
  error: Error | null
  /** 执行变更 */
  mutate: (...params: P) => Promise<T>
  /** 执行变更（同 mutate，兼容 React Query 风格） */
  mutateAsync: (...params: P) => Promise<T>
  /** 重置状态 */
  reset: () => void
}

/**
 * 数据变更 Hook
 *
 * @example
 * const { mutate, isLoading } = useMutation(
 *   (userData) => createUser(userData),
 *   {
 *     onSuccess: (data) => console.log('创建成功:', data),
 *   }
 * )
 * // 使用
 * await mutate({ name: '张三', email: 'zhangsan@example.com' })
 */
export function useMutation<T, P extends unknown[] = unknown[]>(
  mutationFn: (...params: P) => Promise<T>,
  options: UseMutationOptions<T, P> = {}
): UseMutationReturn<T, P> {
  const { optimisticUpdate, rollback, onSuccess, onError, onSettled } = options

  const [data, setData] = useState<T | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  // 用 ref 保持最新的 mutationFn 和回调，避免 mutate 因引用变化重建
  const mutationFnRef = useRef(mutationFn)
  const onSuccessRef = useRef(onSuccess)
  const onErrorRef = useRef(onError)
  const onSettledRef = useRef(onSettled)
  const optimisticUpdateRef = useRef(optimisticUpdate)
  const rollbackRef = useRef(rollback)
  mutationFnRef.current = mutationFn
  onSuccessRef.current = onSuccess
  onErrorRef.current = onError
  onSettledRef.current = onSettled
  optimisticUpdateRef.current = optimisticUpdate
  rollbackRef.current = rollback

  const mutate = useCallback(
    async (...params: P): Promise<T> => {
      // 乐观更新
      if (optimisticUpdateRef.current) {
        try {
          optimisticUpdateRef.current(...params)
        } catch (err) {
          console.error('[useMutation] 乐观更新失败:', err)
        }
      }

      setIsLoading(true)
      setError(null)

      try {
        const result = await mutationFnRef.current(...params)
        setData(result)
        setIsLoading(false)
        onSuccessRef.current?.(result, ...params)
        onSettledRef.current?.(result, null, ...params)
        return result
      } catch (err) {
        // 回滚
        if (rollbackRef.current) {
          try {
            rollbackRef.current()
          } catch (rollbackErr) {
            console.error('[useMutation] 回滚失败:', rollbackErr)
          }
        }

        const mutationError = err instanceof Error ? err : new Error(String(err))
        setError(mutationError)
        setIsLoading(false)
        onErrorRef.current?.(mutationError, ...params)
        onSettledRef.current?.(null, mutationError, ...params)
        throw mutationError
      }
    },
    [] // 通过 ref 读取最新函数，mutate 引用永远稳定
  )

  const reset = useCallback(() => {
    setData(null)
    setError(null)
    setIsLoading(false)
  }, [])

  return {
    data,
    isLoading,
    error,
    mutate,
    mutateAsync: mutate,
    reset,
  }
}
