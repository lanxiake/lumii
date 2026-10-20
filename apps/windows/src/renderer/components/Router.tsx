/**
 * Router - 路由管理组件
 *
 * 根据 activeView 状态渲染对应的页面组件。
 * 设置与低频功能页由 Settings Hub 浮层承载，不再作为全页路由。
 */

import React from 'react'
import { getSlotEntries } from './slots/slot-registry'
import { DashboardPage } from '../pages/DashboardPage/DashboardPage'
import { ChatPage } from '../pages/ChatPage/ChatPage'
import { AutonomousPage } from '../pages/AutonomousPage/AutonomousPage'

/**
 * 视图类型
 *
 * Hub 接管的视图（settings/agents/skills/...）仍保留在类型中，
 * 以便深链回调签名兼容；实际打开走 SettingsHub。
 */
export type ViewType =
  | 'dashboard'
  | 'chat'
  | 'autonomous'
  | 'skills'
  | 'settings'
  | 'memories'
  | 'wiki'
  | 'agents'
  | 'cron'
  | 'plugins'
  | 'mcp'
  /** 插件页面：`plugin:<pluginViewId>`，由 `app.view` 槽位解析 */
  | `plugin:${string}`

interface RouterProps {
  activeView: ViewType
  onViewChange?: (view: ViewType) => void
}

/**
 * 路由组件 - 根据当前视图渲染对应页面
 *
 * 重要：ChatPage 始终挂载（用 CSS 显隐），
 * 保留 useChat 状态（streamMap、runIdToMessageIdRef 等）不因页面切换而丢失。
 */
export const Router: React.FC<RouterProps> = ({ activeView, onViewChange }) => {
  const showChat = activeView === 'chat'

  /**
   * 非 chat 主内容：Hub 视图回落到概览，避免空白
   */
  const renderOtherPage = () => {
    // 插件页面：`plugin:<viewId>` → 在 app.view 槽位里找同 id 的条目。
    // 找不到就回落到概览，而不是白屏——插件被禁用时用户可能还停在那个视图上。
    if (activeView.startsWith('plugin:')) {
      const viewId = activeView.slice('plugin:'.length)
      const entry = getSlotEntries('app.view').find((e) => e.id === viewId)
      if (entry) {
        const PluginView = entry.component as React.ComponentType
        return <PluginView />
      }
      return <DashboardPage onViewChange={onViewChange} />
    }

    switch (activeView) {
      case 'dashboard':
        return <DashboardPage onViewChange={onViewChange} />
      case 'autonomous':
        return <AutonomousPage />
      case 'chat':
        return null
      default:
        // settings / agents / skills 等由 Hub 浮层展示
        return <DashboardPage onViewChange={onViewChange} />
    }
  }

  return (
    <>
      <div style={{ display: showChat ? 'contents' : 'none' }}>
        <ChatPage activeView={activeView} onViewChange={onViewChange} />
      </div>
      {!showChat && renderOtherPage()}
    </>
  )
}
