/**
 * MainLayout Component - 主布局组件
 *
 * 组合 TitleBar + Sidebar + Content 的主布局容器
 * 支持响应式布局（移动端自适应）
 */

import React, { useState, useCallback, useEffect } from 'react';
import clsx from 'clsx';
import { Sidebar, SIDEBAR_TOGGLE_EVENT, ViewType } from '../Sidebar';
import { TitleBar } from '../TitleBar';
import { StatusBar } from '../StatusBar';
import { WindowEdgeGlow } from '../WindowEdgeGlow';
import styles from './MainLayout.module.css';

export interface MainLayoutProps {
  /** 子内容 */
  children: React.ReactNode;
  /** 当前激活的视图 */
  activeView?: ViewType;
  /** 视图切换回调 */
  onViewChange?: (view: ViewType) => void;
  /** Settings Hub 是否打开（侧栏设置按钮高亮） */
  settingsHubOpen?: boolean;
  /** 窗口标题 */
  title?: string;
  /** 应用名称 */
  appName?: string;
  /** 是否已连接 */
  isConnected?: boolean;
  /** 应用版本 */
  version?: string;
  /** 侧边栏是否默认折叠 */
  defaultSidebarCollapsed?: boolean;
  /** Electron API */
  electronAPI?: {
    window: {
      minimize: () => void;
      maximize: () => void;
      close: () => void;
    };
  };
  /** 自定义类名 */
  className?: string;
  /** 是否禁用侧边栏 */
  disableSidebar?: boolean;
  /** 自定义标题栏 */
  customTitleBar?: React.ReactNode;
  /** 自定义侧边栏 */
  customSidebar?: React.ReactNode;
  /** 注入到标题栏连接状态右边的主题切换按钮 */
  themeToggle?: React.ReactNode;
  /** 标题栏额外操作（录屏等） */
  extraActions?: React.ReactNode;
}

/**
 * 主布局组件
 */
export const MainLayout: React.FC<MainLayoutProps> = ({
  children,
  activeView = 'dashboard',
  onViewChange,
  settingsHubOpen = false,
  title,
  appName = '灵栖 Lumii',
  isConnected = false,
  version = 'v0.1.0',
  defaultSidebarCollapsed = false,
  electronAPI,
  className = '',
  disableSidebar = false,
  customTitleBar,
  customSidebar,
  themeToggle,
  extraActions,
}) => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(defaultSidebarCollapsed);
  const [isMobile, setIsMobile] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  /**
   * 刷新最大化状态（最大化时不展示边缘特效）
   */
  const refreshMaximized = useCallback(async () => {
    try {
      const api = electronAPI?.window ?? window.electronAPI?.window;
      if (api && 'isMaximized' in api && typeof api.isMaximized === 'function') {
        setIsMaximized(await api.isMaximized());
        return;
      }
    } catch {
      /* ignore */
    }
    setIsMaximized(
      window.outerWidth >= window.screen.availWidth - 2
      && window.outerHeight >= window.screen.availHeight - 2,
    );
  }, [electronAPI]);

  // 检测移动端
  useEffect(() => {
    const checkMobile = () => {
      const mobile = window.innerWidth <= 768;
      setIsMobile(mobile);
      if (!mobile) {
        setMobileMenuOpen(false);
      }
    };

    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  // 最大化状态（最大化时关闭边缘手电筒特效）
  useEffect(() => {
    const onResize = () => { void refreshMaximized(); };
    window.addEventListener('resize', onResize);
    void refreshMaximized();
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, [refreshMaximized]);

  // 页面内的折叠按钮 / Ctrl+B 都发事件到这里，避免出现第二份折叠状态
  useEffect(() => {
    const onToggle = () => {
      if (isMobile) setMobileMenuOpen((prev) => !prev);
      else setSidebarCollapsed((prev) => !prev);
    };
    window.addEventListener(SIDEBAR_TOGGLE_EVENT, onToggle);
    return () => window.removeEventListener(SIDEBAR_TOGGLE_EVENT, onToggle);
  }, [isMobile]);

  // 处理移动端菜单切换
  const handleMenuClick = useCallback(() => {
    if (isMobile) {
      setMobileMenuOpen(prev => !prev);
    } else {
      setSidebarCollapsed(prev => !prev);
    }
  }, [isMobile]);

  // 处理移动端菜单关闭
  const handleMobileMenuClose = useCallback(() => {
    setMobileMenuOpen(false);
  }, []);

  // 处理视图切换（移动端自动关闭菜单）
  const handleViewChange = useCallback((view: ViewType) => {
    onViewChange?.(view);
    if (isMobile) {
      setMobileMenuOpen(false);
    }
  }, [onViewChange, isMobile]);

  return (
    <div
      className={clsx(
        styles['main-layout'],
        isMaximized && styles['main-layout--maximized'],
        className,
      )}
    >
      {/* 标题栏 */}
      {customTitleBar || (
        <TitleBar
          title={title}
          appName={appName}
          isConnected={isConnected}
          onMenuClick={disableSidebar ? undefined : handleMenuClick}
          showMenuButton={!disableSidebar}
          electronAPI={electronAPI}
          themeToggle={themeToggle}
          extraActions={extraActions}
        />
      )}

      {/* 边缘光效置于标题栏之后、更高 z-index，避免被顶栏遮挡；pointer-events:none 不挡拖拽 */}
      <WindowEdgeGlow disabled={isMaximized} />

      {/* 主体区域 */}
      <div className={styles['main-layout-body']}>
        {/* 侧边栏 */}
        {!disableSidebar && (
          <>
            {customSidebar || (
              <Sidebar
                activeView={activeView}
                onViewChange={handleViewChange}
                settingsHubOpen={settingsHubOpen}
                isConnected={isConnected}
                collapsed={isMobile ? false : sidebarCollapsed}
                onCollapseChange={isMobile ? undefined : setSidebarCollapsed}
                version={version}
                className={isMobile ? (mobileMenuOpen ? 'sidebar-open' : '') : ''}
              />
            )}
            {/* 移动端遮罩层 */}
            {isMobile && mobileMenuOpen && (
              <div 
                className={styles['main-layout-overlay']}
                onClick={handleMobileMenuClose}
              />
            )}
          </>
        )}

        {/* 内容区域 */}
        <main className={styles['main-layout-content']}>
          <div
            className={`${styles['main-layout-content-inner']} ${
              activeView === 'chat' ? styles['main-layout-content-inner--flush'] : ''
            }`}
          >
            {children}
          </div>
        </main>
      </div>

      {/* 底部状态条：会话级观测指标的唯一出口 */}
      <StatusBar />
    </div>
  );
};

export default MainLayout;
