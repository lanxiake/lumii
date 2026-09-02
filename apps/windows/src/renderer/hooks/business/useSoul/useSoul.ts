import { useState, useCallback, useEffect, useRef } from 'react'
import { getSoulContent, updateSoulContent } from '../../../services/soul-service'

const DRAFT_KEY = 'mtbot_soul_draft'

export interface SoulData {
  content: string
  updatedAt: string
}

export interface UseSoulReturn {
  soul: SoulData | null
  isLoading: boolean
  isSaving: boolean
  error: Error | null
  fetchSoul: () => Promise<void>
  updateSoul: (content: string) => Promise<boolean>
  clearError: () => void
  saveDraft: (content: string) => void
  clearDraft: () => void
  hasDraft: () => boolean
  getDraft: () => { content: string; savedAt: string } | null
}

/**
 * 管理 AI 灵魂内容的加载、保存与本地草稿。
 */
export function useSoul(): UseSoulReturn {
  const [soul, setSoul] = useState<SoulData | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const clearError = useCallback(() => setError(null), [])

  /**
   * 从主进程读取 soul.md。
   */
  const fetchSoul = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const data = await getSoulContent()
      setSoul({ content: data.content, updatedAt: data.updatedAt })
    } catch (err) {
      setError(err instanceof Error ? err : new Error('获取 AI 灵魂失败'))
    } finally {
      setIsLoading(false)
    }
  }, [])

  /**
   * 将 SOUL 内容写入本地文件。
   */
  const updateSoul = useCallback(async (content: string): Promise<boolean> => {
    setIsSaving(true)
    setError(null)
    try {
      const result = await updateSoulContent(content)
      localStorage.removeItem(DRAFT_KEY)
      setSoul({ content, updatedAt: result.updatedAt })
      return true
    } catch (err) {
      setError(err instanceof Error ? err : new Error('更新 AI 灵魂失败'))
      return false
    } finally {
      setIsSaving(false)
    }
  }, [])

  const saveDraft = useCallback((content: string) => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ content, savedAt: new Date().toISOString() }))
  }, [])

  const clearDraft = useCallback(() => localStorage.removeItem(DRAFT_KEY), [])

  const hasDraft = useCallback(() => localStorage.getItem(DRAFT_KEY) !== null, [])

  const getDraft = useCallback((): { content: string; savedAt: string } | null => {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    try {
      return JSON.parse(raw) as { content: string; savedAt: string }
    } catch {
      return null
    }
  }, [])

  return { soul, isLoading, isSaving, error, fetchSoul, updateSoul, clearError, saveDraft, clearDraft, hasDraft, getDraft }
}
