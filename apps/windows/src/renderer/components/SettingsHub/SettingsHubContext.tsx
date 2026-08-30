/**
 * SettingsHubContext - 设置浮层 Hub 开关与 Tab 状态
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import {
  DEFAULT_SETTINGS_HUB_STATE,
  viewToHubTab,
  type MergedSettingsCategory,
  type SettingsHubState,
  type SettingsHubTab,
} from './types'
import { consumeMemoriesInitTab } from '../../utils/open-wiki-library'

interface SettingsHubContextValue {
  state: SettingsHubState
  /** Hub 是否打开 */
  isOpen: boolean
  /** 打开 Hub，可指定顶栏 Tab 与设置分类 */
  openHub: (tab?: SettingsHubTab, category?: MergedSettingsCategory) => void
  /** 关闭 Hub */
  closeHub: () => void
  /** 切换顶栏 Tab */
  setTab: (tab: SettingsHubTab) => void
  /** 切换设置左侧分类 */
  setCategory: (category: MergedSettingsCategory) => void
  /** 清除记忆页子 Tab 跳转标记（MemoriesPage 消费后调用） */
  clearMemoriesSubTab: () => void
  /** 根据路由视图打开对应 Hub Tab */
  openHubForView: (view: string) => void
}

const SettingsHubContext = createContext<SettingsHubContextValue | null>(null)

interface SettingsHubProviderProps {
  children: ReactNode
}

/**
 * Settings Hub 状态提供者
 */
export const SettingsHubProvider: React.FC<SettingsHubProviderProps> = ({ children }) => {
  const [state, setState] = useState<SettingsHubState>(DEFAULT_SETTINGS_HUB_STATE)

  const openHub = useCallback((tab: SettingsHubTab = 'settings', category?: MergedSettingsCategory) => {
    setState((prev) => ({
      open: true,
      tab,
      category: category ?? (tab === 'settings' ? prev.category : prev.category),
    }))
  }, [])

  const closeHub = useCallback(() => {
    setState((prev) => ({ ...prev, open: false }))
  }, [])

  const setTab = useCallback((tab: SettingsHubTab) => {
    setState((prev) => ({ ...prev, tab }))
  }, [])

  const setCategory = useCallback((category: MergedSettingsCategory) => {
    setState((prev) => ({ ...prev, category, tab: 'settings' }))
  }, [])

  /** 记忆子 Tab 跳转标记仅用一次，避免后续覆盖用户手动切换 */
  const clearMemoriesSubTab = useCallback(() => {
    setState((prev) => (prev.memoriesSubTab ? { ...prev, memoriesSubTab: null } : prev))
  }, [])

  const openHubForView = useCallback((view: string) => {
    const tab = viewToHubTab(view)
    const memoriesSubTab = view === 'memories' ? consumeMemoriesInitTab() : null
    setState((prev) => ({
      open: true,
      tab,
      category: prev.category,
      memoriesSubTab: memoriesSubTab ?? (view === 'memories' ? prev.memoriesSubTab : null),
    }))
  }, [])

  const value = useMemo<SettingsHubContextValue>(
    () => ({
      state,
      isOpen: state.open,
      openHub,
      closeHub,
      setTab,
      setCategory,
      clearMemoriesSubTab,
      openHubForView,
    }),
    [state, openHub, closeHub, setTab, setCategory, clearMemoriesSubTab, openHubForView],
  )

  return (
    <SettingsHubContext.Provider value={value}>
      {children}
    </SettingsHubContext.Provider>
  )
}

/**
 * 读取 Settings Hub 上下文
 */
export function useSettingsHub(): SettingsHubContextValue {
  const ctx = useContext(SettingsHubContext)
  if (!ctx) {
    throw new Error('useSettingsHub must be used within SettingsHubProvider')
  }
  return ctx
}

export default SettingsHubProvider
