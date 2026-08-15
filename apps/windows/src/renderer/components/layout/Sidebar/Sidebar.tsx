/**
 * Sidebar Component - 侧边栏导航组件
 *
 * 只留高频入口（概览），其余功能页（含插件中心）移入设置。
 * 之下常驻会话列表（默认/渠道 tab，由 ChatPage portal 填充）。
 */

import React, { useState, useCallback } from 'react';

import {
  LayoutDashboard,
  Settings,
  ChevronLeft,
} from '../../ui/Icon';
import { LumiiLogo } from '../../brand/LumiiLogo';
import styles from './Sidebar.module.css';

/**
 * 视图类型
 */
export type ViewType =
  | 'dashboard'
  | 'chat'
  | 'skills'
  | 'settings'
  | 'memories'
  | 'agents'
  | 'cron'
  | 'plugins'
  | 'mcp';

/**
 * 导航菜单项
 */
export interface NavItem {
  id: ViewType;
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
}

export interface SidebarProps {
  /** 当前激活的视图 */
  activeView?: ViewType;
  /** 视图切换回调 */
  onViewChange?: (view: ViewType) => void;
  /** Settings Hub 打开时高亮设置按钮 */
  settingsHubOpen?: boolean;
  /** 是否已连接 */
  isConnected?: boolean;
  /** 是否折叠 */
  collapsed?: boolean;
  /** 折叠状态切换回调 */
  onCollapseChange?: (collapsed: boolean) => void;
  /** 应用版本 */
  version?: string;
  /** 自定义类名 */
  className?: string;
}

/**
 * 侧边栏图标统一尺寸
 */
const ICON_SIZE = 18;

/**
 * 默认导航菜单配置（插件中心等低频入口改由设置页「功能」区进入）
 */
const defaultNavItems: NavItem[] = [
  { id: 'dashboard', label: '概览', icon: <LayoutDashboard size={ICON_SIZE} /> },
];

/** 会话列表挂载点 id：ChatPage 通过 portal 把 ChatSidebar 渲染进来 */
export const SIDEBAR_SESSION_SLOT_ID = 'lumii-sidebar-session-slot';

/** 折叠侧栏事件：页面内的折叠按钮/快捷键都发这个，由 MainLayout 统一处理 */
export const SIDEBAR_TOGGLE_EVENT = 'lumii:toggle-sidebar';

/**
 * 侧边栏组件
 */
export const Sidebar: React.FC<SidebarProps> = ({
  activeView = 'dashboard',
  onViewChange,
  settingsHubOpen = false,
  isConnected = false,
  collapsed = false,
  onCollapseChange,
  version = 'v0.1.0',
  className = '',
}) => {
  const [internalCollapsed, setInternalCollapsed] = useState(collapsed);

  const isCollapsed = onCollapseChange ? collapsed : internalCollapsed;

  const handleCollapseToggle = useCallback(() => {
    const newCollapsed = !isCollapsed;
    if (onCollapseChange) {
      onCollapseChange(newCollapsed);
    } else {
      setInternalCollapsed(newCollapsed);
    }
  }, [isCollapsed, onCollapseChange]);

  const handleViewChange = useCallback((view: ViewType) => {
    onViewChange?.(view);
  }, [onViewChange]);

  // 会话列表常驻（不再有「对话」菜单），只有折叠态 64px 放不下时收掉
  const showSessionSlot = !isCollapsed;

  return (
    <aside className={`${styles.sidebar} ${isCollapsed ? styles['sidebar-collapsed'] : ''} ${className}`}>
      {/* Logo 区域 */}
      <div className={styles['sidebar-header']}>
        <div className={styles['sidebar-logo']}>
          {isCollapsed
            ? <LumiiLogo size={22} />
            : <LumiiLogo size={26} showWordmark />
          }
        </div>
        <button
          className={styles['sidebar-collapse-btn']}
          onClick={handleCollapseToggle}
          title={isCollapsed ? '展开' : '折叠'}
        >
          <ChevronLeft
            size={16}
            style={{ transform: isCollapsed ? 'rotate(180deg)' : undefined }}
          />
        </button>
      </div>

      {/* 导航菜单 */}
      <nav className={`${styles['sidebar-nav']} ${showSessionSlot ? styles['sidebar-nav--compact'] : ''}`}>
        {defaultNavItems.map((item) => (
          <button
            key={item.id}
            className={`${styles['nav-item']} ${activeView === item.id ? styles.active : ''}`}
            onClick={() => handleViewChange(item.id)}
            disabled={item.disabled && !isConnected}
            title={item.label}
          >
            <span className={styles['nav-icon']}>{item.icon}</span>
            {!isCollapsed && <span className={styles['nav-label']}>{item.label}</span>}
          </button>
        ))}
      </nav>

      {/* 会话列表挂载点：默认/渠道 tab + 列表，由 ChatPage portal 填充。
          始终留在 DOM 里（只切 display），否则 portal 目标节点会失效 */}
      <div
        id={SIDEBAR_SESSION_SLOT_ID}
        className={`${styles['session-slot']} ${showSessionSlot ? '' : styles['session-slot--hidden']}`}
      />

      {/* 底部区域 */}
      <div className={styles['sidebar-footer']}>
        {/* 设置按钮 */}
        <button
          className={`${styles['settings-button']} ${settingsHubOpen || activeView === 'settings' ? styles.active : ''}`}
          onClick={() => handleViewChange('settings')}
          title="设置"
          data-app-ui="nav-settings"
        >
          <Settings size={16} />
          {!isCollapsed && <span>设置</span>}
        </button>

        {/* 版本号 */}
        {!isCollapsed && <div className={styles['app-version']}>{version}</div>}
      </div>
    </aside>
  );
};

export default Sidebar;
