/**
 * Router - 路由管理组件
 *
 * 根据 activeView 状态渲染对应的页面组件
 */

import React from 'react'
import { DashboardPage } from '../pages/DashboardPage/DashboardPage'
import { ChatPage } from '../pages/ChatPage/ChatPage'
import { FilesPage } from '../pages/FilesPage/FilesPage'
import { SkillsPage } from '../pages/SkillsPage/SkillsPage'
import { SettingsPage } from '../pages/SettingsPage/SettingsPage'
import { MemoriesPage } from '../pages/MemoriesPage/MemoriesPage'
import { AgentsPage } from '../pages/AgentsPage/AgentsPage'
import { CronPage } from '../pages/CronPage/CronPage'
import { PluginCenterPage } from '../pages/PluginCenterPage/PluginCenterPage'

/**
 * 视图类型
 *
 * 移除 system（系统监控）
 * 合并 subscription + credits → account（账户管理）
 */
export type ViewType =
  | 'dashboard'
  | 'chat'
  | 'files'
  | 'skills'
  | 'settings'
  | 'memories'
  | 'agents'
  | 'cron'
  | 'plugins'

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
  // ChatPage 始终挂载，通过 display 控制显隐
  // 这样 useChat hook 的状态（runIdToMessageIdRef 等）在页面切换时不会丢失
  const showChat = activeView === 'chat'

  // 非 chat 页面的内容（根据 activeView 渲染）
  const renderOtherPage = () => {
    switch (activeView) {
      case 'dashboard':
        return <DashboardPage onViewChange={onViewChange} />
      case 'files':
        return <FilesPage />
      case 'skills':
        return <SkillsPage />
      case 'settings':
        return <SettingsPage onViewChange={onViewChange} />
      case 'memories':
        return <MemoriesPage onViewChange={onViewChange} />
      case 'agents':
        return <AgentsPage onViewChange={onViewChange} />
      case 'cron':
        return <CronPage />
      case 'plugins':
        return <PluginCenterPage />
      default:
        return <DashboardPage onViewChange={onViewChange} />
    }
  }

  return (
    <>
      {/* ChatPage 始终挂载，用 display 控制显隐 */}
      <div style={{ display: showChat ? 'contents' : 'none' }}>
        <ChatPage activeView={activeView} onViewChange={onViewChange} />
      </div>
      {/* 其他页面：非 chat 视图时渲染 */}
      {!showChat && renderOtherPage()}
    </>
  )
}

export default Router
