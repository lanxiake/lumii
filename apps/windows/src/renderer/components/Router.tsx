/**
 * Router - 路由管理组件
 *
 * 根据 activeView 状态渲染对应的页面组件。
 * 设置与低频功能页由 Settings Hub 浮层承载，不再作为全页路由。
 */

import React, { useSyncExternalStore } from 'react'
import { PluginErrorBoundary } from './slots/PluginErrorBoundary'
import { getSlotEntries, subscribeSlots } from './slots/slot-registry'
import { DashboardPage } from '../pages/DashboardPage/DashboardPage'
import { ChatPage } from '../pages/ChatPage/ChatPage'

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
   * `app.view` 的条目必须**订阅**，不能只在渲染时读一次。
   *
   * 不订阅的后果（2026-10-21 探针实测）：停在插件页时禁用该插件，槽位条目已经注销，
   * 但 Router 不重渲染 → 插件页面继续挂着 → 里面的 setInterval / 监听器**永远不停**。
   * （导航与卡片走 `SlotHost`，它们本来就订阅了，所以只有整页有这个洞。）
   */
  const pluginViews = useSyncExternalStore(
    subscribeSlots,
    () => getSlotEntries('app.view'),
    () => getSlotEntries('app.view'),
  )

  /**
   * 非 chat 主内容：Hub 视图回落到概览，避免空白
   */
  const renderOtherPage = () => {
    // 插件页面：`plugin:<viewId>`，以及历史遗留的 `autonomous`。
    // 统一在 app.view 槽位里按 id 找条目；找不到就回落概览——插件被禁用时
    // 用户可能还停在那个视图上，此时条目已注销，页面必须跟着消失。
    const viewId = activeView.startsWith('plugin:')
      ? activeView.slice('plugin:'.length)
      : activeView === 'autonomous'
        ? 'autonomous'
        : null
    if (viewId) {
      const entry = pluginViews.find((e) => e.id === viewId)
      if (entry) {
        const PluginView = entry.component as React.ComponentType<{
          onViewChange?: (view: ViewType) => void
        }>
        // 传 onViewChange：插件页面要能自己跳转（比如「回概览」）。
        // 页面用边界包住：插件渲染抛错只毁这一块，不该让整个客户端变错误页。
        return (
          <PluginErrorBoundary label={entry.owner ?? entry.id}>
            <PluginView onViewChange={onViewChange} />
          </PluginErrorBoundary>
        )
      }
      return <DashboardPage onViewChange={onViewChange} />
    }

    switch (activeView) {
      case 'dashboard':
        return <DashboardPage onViewChange={onViewChange} />
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
