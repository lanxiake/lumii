/**
 * useUserMemory Hook
 *
 * 管理用户记忆的状态和 API 调用
 * 包含本地草稿自动保存功能（30秒间隔）
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import type { UserMemory } from '../../../types/user-memory'
import { getUserMemory, updateUserMemory } from '../../../services/user-memory-service'

const DRAFT_KEY = 'mtbot_memory_draft'
const AUTO_SAVE_INTERVAL = 30000 // 30秒

export interface UseUserMemoryReturn {
  /** 记忆内容 */
  memory: UserMemory | null
  /** 是否正在加载 */
  isLoading: boolean
  /** 保存中状态 */
  isSaving: boolean
  /** 错误对象 */
  error: Error | null
  /** 读取记忆 */
  fetchMemory: () => Promise<void>
  /** 更新记忆 */
  updateMemory: (content: string) => Promise<boolean>
  /** 清除错误 */
  clearError: () => void
  /** 保存草稿 */
  saveDraft: (content: string) => void
  /** 清除草稿 */
  clearDraft: () => void
  /** 检查是否有草稿 */
  hasDraft: () => boolean
  /** 获取草稿内容 */
  getDraft: () => { content: string; savedAt: string } | null
}

export function useUserMemory(): UseUserMemoryReturn {
  const [memory, setMemory] = useState<UserMemory | null>(null)
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [isSaving, setIsSaving] = useState<boolean>(false)
  const [error, setError] = useState<Error | null>(null)
  const autoSaveIntervalRef = useRef<NodeJS.Timeout | null>(null)

  /**
   * 清除错误
   */
  const clearError = useCallback(() => {
    setError(null)
  }, [])

  /**
   * 加载用户记忆
   */
  const fetchMemory = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      const data = await getUserMemory()
      setMemory(data)
    } catch (err) {
      const error = err instanceof Error ? err : new Error('获取记忆失败')
      setError(error)
      console.error('[useUserMemory] fetchMemory 失败:', error)
    } finally {
      setIsLoading(false)
    }
  }, [])

  /**
   * 更新用户记忆
   */
  const updateMemory = useCallback(async (content: string): Promise<boolean> => {
    setIsSaving(true)
    setError(null)

    try {
      const result = await updateUserMemory(content)

      // 清除草稿
      localStorage.removeItem(DRAFT_KEY)

      // 更新本地状态
      setMemory({
        content,
        updatedAt: result.updatedAt
      })

      return true
    } catch (err) {
      const error = err instanceof Error ? err : new Error('更新记忆失败')
      setError(error)
      console.error('[useUserMemory] updateMemory 失败:', error)
      return false
    } finally {
      setIsSaving(false)
    }
  }, [])

  /**
   * 保存草稿到本地存储
   */
  const saveDraft = useCallback((content: string): void => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      content,
      savedAt: new Date().toISOString()
    }))
  }, [])

  /**
   * 清除草稿
   */
  const clearDraft = useCallback((): void => {
    localStorage.removeItem(DRAFT_KEY)
  }, [])

  /**
   * 检查是否有草稿
   */
  const hasDraft = useCallback((): boolean => {
    return localStorage.getItem(DRAFT_KEY) !== null
  }, [])

  /**
   * 获取草稿内容
   */
  const getDraft = useCallback((): { content: string; savedAt: string } | null => {
    const draft = localStorage.getItem(DRAFT_KEY)
    if (draft) {
      try {
        return JSON.parse(draft)
      } catch {
        return null
      }
    }
    return null
  }, [])

  // 清理定时器
  useEffect(() => {
    return () => {
      if (autoSaveIntervalRef.current) {
        clearInterval(autoSaveIntervalRef.current)
      }
    }
  }, [])

  return {
    memory,
    isLoading,
    isSaving,
    error,
    fetchMemory,
    updateMemory,
    clearError,
    saveDraft,
    clearDraft,
    hasDraft,
    getDraft
  }
}
