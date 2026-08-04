/**
 * MainLayout Component - 主布局组件
 *
 * 组合 TitleBar + Sidebar + Content 的主布局容器
 * 支持响应式布局（移动端自适应）
 */

import React, { useState, useCallback, useEffect } from 'react';
import { Sidebar, ViewType, User } from '../Sidebar';
import { TitleBar } from '../TitleBar';
import styles from './MainLayout.module.css';

export interface MainLayoutProps {
  /** 子内容 */
  children: React.ReactNode;
  /** 当前激活的视图 */
  activeView?: ViewType;
  /** 视图切换回调 */
  onViewChange?: (view: ViewType) => void;
  /** 窗口标题 */
  title?: string;
  /** 应用名称 */
  appName?: string;
  /** 是否已连接 */
  isConnected?: boolean;
  /** 用户信息 */
  user?: User | null;
  /** 登出回调 */
  onLogout?: () => void;
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
}

/**
 * 主布局组件
 */
export const MainLayout: React.FC<MainLayoutProps> = ({
  children,
  activeView = 'dashboard',
  onViewChange,
  title,
  appName = '灵栖 Lumii',
  isConnected = false,
  user,
  onLogout,
  version = 'v0.2.0',
  defaultSidebarCollapsed = false,
  electronAPI,
  className = '',
  disableSidebar = false,
  customTitleBar,
  customSidebar,
  themeToggle,
}) => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(defaultSidebarCollapsed);
  const [isMobile, setIsMobile] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

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
    <div className={`${styles['main-layout']} ${className}`}>
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
        />
      )}

      {/* 主体区域 */}
      <div className={styles['main-layout-body']}>
        {/* 侧边栏 */}
        {!disableSidebar && (
          <>
            {customSidebar || (
              <Sidebar
                activeView={activeView}
                onViewChange={handleViewChange}
                isConnected={isConnected}
                collapsed={isMobile ? false : sidebarCollapsed}
                onCollapseChange={isMobile ? undefined : setSidebarCollapsed}
                user={user}
                onLogout={onLogout}
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
          <div className={styles['main-layout-content-inner']}>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
};

export default MainLayout;
