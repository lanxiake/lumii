/**
 * SkillsContext - 技能全局管理上下文
 *
 * 提供全局的技能列表管理功能
 */

import React, { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from 'react'
import { useAuth } from '../AuthContext/AuthContext'

/**
 * 技能信息
 */
export interface Skill {
  id: string
  name: string
  description?: string
  version: string
  author?: string
  iconUrl?: string
  enabled: boolean
  installedAt: string
  updatedAt?: string
  config?: Record<string, unknown>
}

/**
 * 安装技能参数
 */
export interface InstallSkillParams {
  id: string
  source: 'registry' | 'file' | 'url'
  url?: string
  filePath?: string
}

/**
 * 技能状态
 */
export interface SkillsState {
  /** 所有技能列表 */
  skills: Skill[]
  /** 启用的技能 */
  enabledSkills: Skill[]
  /** 禁用的技能 */
  disabledSkills: Skill[]
  /** 是否正在加载 */
  isLoading: boolean
  /** 是否正在安装 */
  isInstalling: boolean
  /** 错误信息 */
  error: string | null
}

/**
 * 技能上下文类型
 */
interface SkillsContextType extends SkillsState {
  /** 刷新技能列表 */
  refreshSkills: () => Promise<void>
  /** 安装技能 */
  installSkill: (params: InstallSkillParams) => Promise<{ success: boolean; error?: string }>
  /** 卸载技能 */
  uninstallSkill: (skillId: string) => Promise<{ success: boolean; error?: string }>
  /** 启用技能 */
  enableSkill: (skillId: string) => Promise<{ success: boolean; error?: string }>
  /** 禁用技能 */
  disableSkill: (skillId: string) => Promise<{ success: boolean; error?: string }>
  /** 更新技能配置 */
  updateSkillConfig: (skillId: string, config: Record<string, unknown>) => Promise<{ success: boolean; error?: string }>
  /** 清除错误 */
  clearError: () => void
}

// localStorage keys
const STORAGE_KEYS = {
  SKILLS_CACHE: 'mtbot_skills_cache',
  SKILLS_ENABLED: 'mtbot_skills_enabled',
}

/**
 * 从 localStorage 加载缓存的技能数据
 */
function loadCachedSkills(): Skill[] {
  try {
    const cached = localStorage.getItem(STORAGE_KEYS.SKILLS_CACHE)
    if (cached) {
      const parsed = JSON.parse(cached) as Skill[]
      return parsed.map(skill => ({
        ...skill,
        installedAt: skill.installedAt,
        updatedAt: skill.updatedAt,
      }))
    }
  } catch (error) {
    console.error('[SkillsContext] 加载缓存技能失败:', error)
  }
  return []
}

/**
 * 保存技能数据到 localStorage
 */
function saveCachedSkills(skills: Skill[]): void {
  try {
    localStorage.setItem(STORAGE_KEYS.SKILLS_CACHE, JSON.stringify(skills))
  } catch (error) {
    console.error('[SkillsContext] 保存技能缓存失败:', error)
  }
}

// 创建上下文
const SkillsContext = createContext<SkillsContextType | undefined>(undefined)

/**
 * SkillsProvider Props
 */
interface SkillsProviderProps {
  children: ReactNode
  /** 是否自动加载 */
  autoLoad?: boolean
}

/**
 * SkillsProvider - 技能状态提供者
 */
export const SkillsProvider: React.FC<SkillsProviderProps> = ({ children, autoLoad = true }) => {
  const { isAuthenticated, isTokenSynced } = useAuth()
  const cachedSkills = loadCachedSkills()
  const [state, setState] = useState<SkillsState>({
    skills: cachedSkills,
    enabledSkills: cachedSkills.filter(s => s.enabled),
    disabledSkills: cachedSkills.filter(s => !s.enabled),
    isLoading: false, // 初始不加载，等待认证
    isInstalling: false,
    error: null,
  })

  // 防止重复加载
  const hasLoadedRef = useRef(false)

  /**
   * 更新状态中的派生数据
   */
  const updateDerivedState = useCallback((skills: Skill[]) => {
    setState(prev => ({
      ...prev,
      skills,
      enabledSkills: skills.filter(s => s.enabled),
      disabledSkills: skills.filter(s => !s.enabled),
    }))
  }, [])

  /**
   * 刷新技能列表
   */
  const refreshSkills = useCallback(async (): Promise<void> => {
    console.log('[SkillsContext] 刷新技能列表')

    setState(prev => ({ ...prev, isLoading: true, error: null }))

    try {
      // 检查 API 是否可用
      if (!window.electronAPI?.skills) {
        // 使用缓存数据
        console.log('[SkillsContext] skills API 不可用，使用缓存数据')
        setState(prev => ({ ...prev, isLoading: false }))
        return
      }

      const response = await window.electronAPI.skills.getInstalledSkills() as {
        success: boolean
        data?: Skill[]
        error?: string
      }

      if (response.success && response.data) {
        const skills = response.data
        updateDerivedState(skills)
        saveCachedSkills(skills)
        console.log('[SkillsContext] 技能列表已更新:', skills.length)
      } else {
        throw new Error(response.error || '获取技能列表失败')
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '刷新技能列表失败'
      console.error('[SkillsContext] 刷新失败:', errorMessage)
      setState(prev => ({ ...prev, error: errorMessage }))
    } finally {
      setState(prev => ({ ...prev, isLoading: false }))
    }
  }, [updateDerivedState])

  /**
   * 安装技能
   */
  const installSkill = useCallback(async (params: InstallSkillParams): Promise<{ success: boolean; error?: string }> => {
    console.log('[SkillsContext] 安装技能:', params.id)

    setState(prev => ({ ...prev, isInstalling: true, error: null }))

    try {
      if (!window.electronAPI?.skills) {
        throw new Error('skills API 不可用')
      }

      const response = await window.electronAPI.skills.installSkill(params) as {
        success: boolean
        data?: Skill
        error?: string
      }

      if (response.success && response.data) {
        // 添加到列表
        setState(prev => {
          const existingIndex = prev.skills.findIndex(s => s.id === response.data!.id)
          let newSkills: Skill[]

          if (existingIndex >= 0) {
            // 更新现有技能
            newSkills = [...prev.skills]
            newSkills[existingIndex] = response.data!
          } else {
            // 添加新技能
            newSkills = [...prev.skills, response.data!]
          }

          saveCachedSkills(newSkills)

          return {
            ...prev,
            skills: newSkills,
            enabledSkills: newSkills.filter(s => s.enabled),
            disabledSkills: newSkills.filter(s => !s.enabled),
            isInstalling: false,
          }
        })

        console.log('[SkillsContext] 技能安装成功:', response.data.id)
        return { success: true }
      } else {
        throw new Error(response.error || '安装技能失败')
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '安装技能失败'
      console.error('[SkillsContext] 安装失败:', errorMessage)
      setState(prev => ({ ...prev, isInstalling: false, error: errorMessage }))
      return { success: false, error: errorMessage }
    }
  }, [])

  /**
   * 卸载技能
   */
  const uninstallSkill = useCallback(async (skillId: string): Promise<{ success: boolean; error?: string }> => {
    console.log('[SkillsContext] 卸载技能:', skillId)

    setState(prev => ({ ...prev, isInstalling: true, error: null }))

    try {
      if (!window.electronAPI?.skills) {
        throw new Error('skills API 不可用')
      }

      const response = await window.electronAPI.skills.uninstallSkill(skillId) as {
        success: boolean
        error?: string
      }

      if (response.success) {
        // 从列表中移除
        setState(prev => {
          const newSkills = prev.skills.filter(s => s.id !== skillId)
          saveCachedSkills(newSkills)

          return {
            ...prev,
            skills: newSkills,
            enabledSkills: newSkills.filter(s => s.enabled),
            disabledSkills: newSkills.filter(s => !s.enabled),
            isInstalling: false,
          }
        })

        console.log('[SkillsContext] 技能卸载成功:', skillId)
        return { success: true }
      } else {
        throw new Error(response.error || '卸载技能失败')
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '卸载技能失败'
      console.error('[SkillsContext] 卸载失败:', errorMessage)
      setState(prev => ({ ...prev, isInstalling: false, error: errorMessage }))
      return { success: false, error: errorMessage }
    }
  }, [])

  /**
   * 启用技能
   */
  const enableSkill = useCallback(async (skillId: string): Promise<{ success: boolean; error?: string }> => {
    console.log('[SkillsContext] 启用技能:', skillId)

    try {
      if (!window.electronAPI?.skills) {
        throw new Error('skills API 不可用')
      }

      const ok = await window.electronAPI.skills.enableSkill(skillId)

      if (ok) {
        setState(prev => {
          const newSkills = prev.skills.map(s =>
            s.id === skillId ? { ...s, enabled: true } : s
          )
          saveCachedSkills(newSkills)

          return {
            ...prev,
            skills: newSkills,
            enabledSkills: newSkills.filter(s => s.enabled),
            disabledSkills: newSkills.filter(s => !s.enabled),
          }
        })

        console.log('[SkillsContext] 技能已启用:', skillId)
        return { success: true }
      } else {
        throw new Error('启用技能失败')
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '启用技能失败'
      console.error('[SkillsContext] 启用失败:', errorMessage)
      return { success: false, error: errorMessage }
    }
  }, [])

  /**
   * 禁用技能
   */
  const disableSkill = useCallback(async (skillId: string): Promise<{ success: boolean; error?: string }> => {
    console.log('[SkillsContext] 禁用技能:', skillId)

    try {
      if (!window.electronAPI?.skills) {
        throw new Error('skills API 不可用')
      }

      const ok = await window.electronAPI.skills.disableSkill(skillId)

      if (ok) {
        setState(prev => {
          const newSkills = prev.skills.map(s =>
            s.id === skillId ? { ...s, enabled: false } : s
          )
          saveCachedSkills(newSkills)

          return {
            ...prev,
            skills: newSkills,
            enabledSkills: newSkills.filter(s => s.enabled),
            disabledSkills: newSkills.filter(s => !s.enabled),
          }
        })

        console.log('[SkillsContext] 技能已禁用:', skillId)
        return { success: true }
      } else {
        throw new Error('禁用技能失败')
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '禁用技能失败'
      console.error('[SkillsContext] 禁用失败:', errorMessage)
      return { success: false, error: errorMessage }
    }
  }, [])

  /**
   * 更新技能配置
   */
  const updateSkillConfig = useCallback(async (
    skillId: string,
    config: Record<string, unknown>
  ): Promise<{ success: boolean; error?: string }> => {
    console.log('[SkillsContext] 更新技能配置:', skillId)

    try {
      if (!window.electronAPI?.skills) {
        throw new Error('skills API 不可用')
      }

      const response = await window.electronAPI.skills.updateSkillConfig(skillId, config) as {
        success: boolean
        error?: string
      }

      if (response.success) {
        setState(prev => {
          const newSkills = prev.skills.map(s =>
            s.id === skillId ? { ...s, config: { ...s.config, ...config } } : s
          )
          saveCachedSkills(newSkills)

          return {
            ...prev,
            skills: newSkills,
            enabledSkills: newSkills.filter(s => s.enabled),
            disabledSkills: newSkills.filter(s => !s.enabled),
          }
        })

        console.log('[SkillsContext] 技能配置已更新:', skillId)
        return { success: true }
      } else {
        throw new Error(response.error || '更新技能配置失败')
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '更新技能配置失败'
      console.error('[SkillsContext] 更新配置失败:', errorMessage)
      return { success: false, error: errorMessage }
    }
  }, [])

  /**
   * 清除错误
   */
  const clearError = useCallback(() => {
    setState(prev => ({ ...prev, error: null }))
  }, [])

  /**
   * 自动加载技能列表（仅在已认证且 token 已同步时）
   */
  useEffect(() => {
    if (autoLoad && isAuthenticated && isTokenSynced && !hasLoadedRef.current) {
      console.log('[SkillsContext] 用户已认证且 token 已同步，自动加载技能列表')
      hasLoadedRef.current = true
      refreshSkills()
    }
  }, [autoLoad, isAuthenticated, isTokenSynced, refreshSkills])

  const value: SkillsContextType = {
    ...state,
    refreshSkills,
    installSkill,
    uninstallSkill,
    enableSkill,
    disableSkill,
    updateSkillConfig,
    clearError,
  }

  return <SkillsContext.Provider value={value}>{children}</SkillsContext.Provider>
}

/**
 * useSkills Hook - 使用技能上下文
 */
export function useSkills(): SkillsContextType {
  const context = useContext(SkillsContext)
  if (context === undefined) {
    throw new Error('useSkills must be used within a SkillsProvider')
  }
  return context
}

export default SkillsContext
