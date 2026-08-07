/**
 * App Component - 主应用组件（精简版）
 *
 * MtBot Assistant 的根组件 - 重构后版本
 * 原 546 行代码精简为 ~60 行，通过提取组件实现职责分离
 */

import React, { useState, useCallback, useEffect } from 'react'
import { AppProviders } from './contexts/AppProviders'
import { Router, ViewType } from './components/Router'
import { DeviceBindWizard } from './components/DeviceBindWizard'
import { WorkspaceWizard } from './components/WorkspaceWizard'
import { GlobalModals } from './components/GlobalModals'
import { MainLayout } from './components/layout/MainLayout/MainLayout'
import { SettingsHubModal, useSettingsHub, isHubView } from './components/SettingsHub'
import { SplashOverlay } from './components/SplashOverlay/SplashOverlay'
import { useTheme } from './contexts/ThemeContext/ThemeContext'
import {
  useAgentRuntimeActions,
  useAgentRuntimeGlobalState,
} from './hooks/business/useAgentRuntime/useAgentRuntime'
import { readPersistedSessionThinkingPrefs } from '../shared/session-thinking-prefs'
import { getProviderConfig, isChatProviderReady } from './services/model-config-service'

/**
 * 是否跳过开机画面（托盘静默启动 / 测试 / 本会话已播过）
 */
function shouldSkipSplash(): boolean {
  try {
    if (sessionStorage.getItem('lumii.splash.done') === '1') return true
  } catch {
    // ignore
  }
  if (typeof window === 'undefined') return false
  const skip = window.electronAPI?.splash?.shouldSkip?.()
  return Boolean(skip)
}
/**
 * 宠物模式会话同步：把主窗口当前 sessionKey 同步到主进程，
 * 供独立宠物窗口语音通话跟随当前 Chat 会话（D4 决策）。
 */
const PetSessionSync: React.FC = () => {
  const currentSessionKey = useAgentRuntimeGlobalState((s) => s.currentSessionKey)
  const runtimeActions = useAgentRuntimeActions()
  useEffect(() => {
    if (!currentSessionKey) return
    void window.electronAPI?.pet?.setActiveSessionKey(currentSessionKey)
    const prefs = readPersistedSessionThinkingPrefs()
    void runtimeActions.setSessionThinkingPrefs(currentSessionKey, prefs)
  }, [currentSessionKey, runtimeActions])
  return null
}

/**
 * 认证包装组件 - 处理认证状态与 Settings Hub 分流
 */
const AuthenticatedApp: React.FC = () => {
  const [activeView, setActiveView] = useState<ViewType>('dashboard')
  const { appliedTheme, toggleTheme } = useTheme()
  const { openHub, openHubForView, closeHub, isOpen: hubOpen } = useSettingsHub()
  /** 本地 chat 模型是否已启用并可调用（独立版用此驱动标题栏绿点） */
  const [modelReady, setModelReady] = useState(false)

  /**
   * 刷新本地模型就绪状态
   */
  const refreshModelReady = useCallback(async () => {
    try {
      const cfg = await getProviderConfig()
      setModelReady(isChatProviderReady(cfg))
    } catch {
      setModelReady(false)
    }
  }, [])

  useEffect(() => {
    void refreshModelReady()
    const onChanged = () => { void refreshModelReady() }
    window.addEventListener('mtbot:provider-config-changed', onChanged)
    window.addEventListener('mtbot:chat-model-changed', onChanged)
    return () => {
      window.removeEventListener('mtbot:provider-config-changed', onChanged)
      window.removeEventListener('mtbot:chat-model-changed', onChanged)
    }
  }, [refreshModelReady])

  // 独立版：本地 chat 模型就绪即视为「已连接」
  const isConnected = modelReady

  /**
   * 视图切换：Hub 视图打开浮层；主壳视图关闭浮层并切换底层页面
   */
  const handleViewChange = useCallback((view: ViewType) => {
    if (isHubView(view)) {
      openHubForView(view)
      return
    }
    closeHub()
    setActiveView(view)
  }, [openHubForView, closeHub])

  // 监听主进程发送的导航到设置页面事件
  useEffect(() => {
    const handleNavigateToSettings = () => {
      openHub('settings')
    }
    window.electronAPI.on('navigate-to-settings', handleNavigateToSettings)
    return () => {
      window.electronAPI.off('navigate-to-settings', handleNavigateToSettings)
    }
  }, [openHub])

  const themeToggleBtn = (
    <button
      type="button"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 22,
        borderRadius: 'var(--radius-md)',
        border: '1px solid var(--color-border)',
        background: 'var(--color-bg-secondary)',
        color: 'var(--color-text-secondary)',
        cursor: 'pointer',
        flexShrink: 0,
        transition: 'background 0.15s, color 0.15s, border-color 0.15s',
        padding: 0,
      }}
      onClick={toggleTheme}
      title={appliedTheme === 'dark' ? '切换为浅色主题' : '切换为深色主题'}
      aria-label={appliedTheme === 'dark' ? '切换为浅色主题' : '切换为深色主题'}
    >
      {appliedTheme === 'dark' ? (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  )

  return (
    <MainLayout
      activeView={activeView}
      onViewChange={handleViewChange}
      settingsHubOpen={hubOpen}
      isConnected={isConnected}
      themeToggle={themeToggleBtn}
      defaultSidebarCollapsed={false}
    >
      <PetSessionSync />
      <Router activeView={activeView} onViewChange={handleViewChange} />
      <SettingsHubModal onViewChange={handleViewChange} />
    </MainLayout>
  )
}

/**
 * 主应用内容组件
 */
const AppContent: React.FC = () => {
  const [splashDone, setSplashDone] = useState(shouldSkipSplash)

  // 独立版无登录：直接渲染主应用；开机画面覆盖在主窗口内全屏播放
  return (
    <>
      {!splashDone && <SplashOverlay onDone={() => setSplashDone(true)} />}
      <AuthenticatedApp />
      <DeviceBindWizard />
      <WorkspaceWizard />
      <GlobalModals />
    </>
  )
}

/**
 * 主应用组件
 */
const App: React.FC = () => {
  return (
    <AppProviders>
      <AppContent />
    </AppProviders>
  )
}

export default App
