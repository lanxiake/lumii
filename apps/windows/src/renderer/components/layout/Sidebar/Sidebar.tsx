/**
 * Sidebar Component - 侧边栏导航组件
 *
 * 显示导航菜单项、用户信息和设置入口
 */

import React, { useState, useCallback } from 'react';

import {
  LayoutDashboard,
  MessageSquare,
  Users,
  Clock,
  Wrench,
  Brain,
  Settings,
  LogOut,
  ChevronLeft,
  Plug,
} from '../../ui/Icon';
import { LumiiLogo } from '../../brand/LumiiLogo';
import styles from './Sidebar.module.css';

/**
 * 视图类型
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
  | 'plugins';

/**
 * 导航菜单项
 */
export interface NavItem {
  id: ViewType;
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
}

/**
 * 用户信息
 */
export interface User {
  id: string;
  displayName?: string;
  email?: string;
  phone?: string;
  avatarUrl?: string;
}

export interface SidebarProps {
  /** 当前激活的视图 */
  activeView?: ViewType;
  /** 视图切换回调 */
  onViewChange?: (view: ViewType) => void;
  /** 是否已连接 */
  isConnected?: boolean;
  /** 是否折叠 */
  collapsed?: boolean;
  /** 折叠状态切换回调 */
  onCollapseChange?: (collapsed: boolean) => void;
  /** 当前用户信息 */
  user?: User | null;
  /** 登出回调 */
  onLogout?: () => void;
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
 * 默认导航菜单配置
 */
const defaultNavItems: NavItem[] = [
  { id: 'dashboard', label: '概览', icon: <LayoutDashboard size={ICON_SIZE} /> },
  { id: 'chat', label: '对话', icon: <MessageSquare size={ICON_SIZE} /> },
  { id: 'agents', label: 'AI 团队', icon: <Users size={ICON_SIZE} /> },
  { id: 'cron', label: '定时任务', icon: <Clock size={ICON_SIZE} /> },
  { id: 'skills', label: '技能管理', icon: <Wrench size={ICON_SIZE} />, disabled: true },
  { id: 'memories', label: '记忆管理', icon: <Brain size={ICON_SIZE} /> },
  { id: 'plugins', label: '插件中心', icon: <Plug size={ICON_SIZE} /> },
];

/**
 * 侧边栏组件
 */
export const Sidebar: React.FC<SidebarProps> = ({
  activeView = 'dashboard',
  onViewChange,
  isConnected = false,
  collapsed = false,
  onCollapseChange,
  user,
  onLogout,
  version = 'v0.3.2',
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

  const getInitials = (name: string) => {
    return name.charAt(0).toUpperCase();
  };

  const displayName = user?.displayName || user?.phone || user?.email || '用户';
  const displayId = user?.phone || user?.email;

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
      <nav className={styles['sidebar-nav']}>
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

      {/* 底部区域 */}
      <div className={styles['sidebar-footer']}>
        {/* 设置按钮 */}
        <button
          className={`${styles['settings-button']} ${activeView === 'settings' ? styles.active : ''}`}
          onClick={() => handleViewChange('settings')}
          title="设置"
        >
          <Settings size={16} />
          {!isCollapsed && <span>设置</span>}
        </button>

        {/* 用户信息 */}
        {user && !isCollapsed && (
          <div className={styles['user-info']}>
            <div className={styles['user-avatar']}>
              {user.avatarUrl ? (
                <img src={user.avatarUrl} alt={displayName} />
              ) : (
                <span className={styles['avatar-placeholder']}>{getInitials(displayName)}</span>
              )}
            </div>
            <div className={styles['user-details']}>
              <span className={styles['user-name']}>{displayName}</span>
              {displayId && <span className={styles['user-id']}>{displayId}</span>}
            </div>
            {onLogout && (
              <button
                className={styles['logout-button']}
                onClick={onLogout}
                title="登出"
              >
                <LogOut size={16} />
              </button>
            )}
          </div>
        )}

        {/* 折叠状态下的用户头像 */}
        {user && isCollapsed && (
          <div className={styles['user-avatar-collapsed']} title={displayName}>
            {user.avatarUrl ? (
              <img src={user.avatarUrl} alt={displayName} />
            ) : (
              <span className={styles['avatar-placeholder']}>{getInitials(displayName)}</span>
            )}
          </div>
        )}

        {/* 版本号 */}
        {!isCollapsed && <div className={styles['app-version']}>{version}</div>}
      </div>
    </aside>
  );
};

export default Sidebar;
