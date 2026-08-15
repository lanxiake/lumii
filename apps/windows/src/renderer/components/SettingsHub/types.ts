/**
 * Settings Hub 类型与常量
 *
 * 顶栏 Tab 覆盖设置与各功能模块；设置区内再分左侧分类。
 */

import type { ReactNode } from 'react'

/** Hub 顶部横向 Tab */
export type SettingsHubTab =
  | 'settings'
  | 'agents'
  | 'skills'
  | 'mcp'
  | 'cron'
  | 'memories'
  | 'plugins'

/** 设置区内左侧分类 */
export type MergedSettingsCategory =
  | 'general'
  | 'workspace'
  | 'modelConfig'
  | 'voice'
  | 'channels'
  | 'codingDev'
  | 'pet'
  | 'usage'
  | 'privacy'
  | 'aboutAndUpdate'

export interface SettingsHubState {
  open: boolean
  tab: SettingsHubTab
  category: MergedSettingsCategory
}

export const DEFAULT_SETTINGS_HUB_STATE: SettingsHubState = {
  open: false,
  tab: 'settings',
  category: 'general',
}

/** 顶栏 Tab 配置 */
export const SETTINGS_HUB_TABS: Array<{ id: SettingsHubTab; label: string }> = [
  { id: 'settings', label: '设置' },
  { id: 'agents', label: 'AI 团队' },
  { id: 'skills', label: '技能' },
  { id: 'mcp', label: 'MCP' },
  { id: 'cron', label: '定时任务' },
  { id: 'memories', label: '记忆' },
  { id: 'plugins', label: '插件' },
]

/** 可被 Hub 接管的路由视图 */
export const HUB_VIEW_TABS = [
  'settings',
  'agents',
  'skills',
  'mcp',
  'cron',
  'memories',
  'plugins',
] as const

export type HubViewType = (typeof HUB_VIEW_TABS)[number]

/**
 * 判断视图是否应由 Settings Hub 打开
 */
export function isHubView(view: string): view is HubViewType {
  return (HUB_VIEW_TABS as readonly string[]).includes(view)
}

/**
 * 将路由 ViewType 映射为 Hub Tab（mcp 仅 Hub 使用）
 */
export function viewToHubTab(view: string): SettingsHubTab {
  if (view === 'mcp') return 'mcp'
  if (isHubView(view)) return view
  return 'settings'
}

export interface SettingsCategoryItem {
  id: MergedSettingsCategory
  label: string
  icon: ReactNode
}
