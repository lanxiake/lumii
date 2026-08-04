/**
 * TitleBar Component - 自定义窗口标题栏
 *
 * 无边框窗口的自定义标题栏，包含拖拽区域和窗口控制按钮
 */

import React, { useCallback, useState, useEffect } from 'react';
import styles from './TitleBar.module.css';

export interface TitleBarProps {
  /** 窗口标题 */
  title?: string;
  /** 应用名称 */
  appName?: string;
  /** 是否已连接（模型就绪 / Gateway） */
  isConnected?: boolean;
  /** 状态点悬停提示（覆盖默认「已连接/未连接」） */
  connectionStatusTitle?: string;
  /** 点击菜单按钮回调（移动端/折叠侧边栏） */
  onMenuClick?: () => void;
  /** 是否显示菜单按钮 */
  showMenuButton?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 主题切换按钮（由外部注入，放在连接状态右边） */
  themeToggle?: React.ReactNode;
  /** Electron API 对象（用于窗口控制） */
  electronAPI?: {
    window: {
      minimize: () => void;
      maximize: () => void;
      close: () => void;
    };
  };
}

/**
 * 标题栏组件
 */
export const TitleBar: React.FC<TitleBarProps> = ({
  title,
  appName = '灵栖 Lumii',
  isConnected = false,
  connectionStatusTitle,
  onMenuClick,
  showMenuButton = true,
  className = '',
  themeToggle,
  electronAPI,
}) => {
  const [isMaximized, setIsMaximized] = useState(false);

  // 监听窗口最大化状态变化
  useEffect(() => {
    const handleResize = () => {
      // 检查窗口是否最大化（通过窗口尺寸与屏幕尺寸比较）
      if (typeof window !== 'undefined') {
        const isMax = window.innerWidth === window.screen.availWidth && 
                      window.innerHeight === window.screen.availHeight;
        setIsMaximized(isMax);
      }
    };

    window.addEventListener('resize', handleResize);
    handleResize();

    return () => window.removeEventListener('resize', handleResize);
  }, []);

  /**
   * 最小化窗口
   */
  const handleMinimize = useCallback(() => {
    if (electronAPI?.window?.minimize) {
      electronAPI.window.minimize();
    } else if (typeof window !== 'undefined' && (window as any).electronAPI?.window?.minimize) {
      (window as any).electronAPI.window.minimize();
    }
  }, [electronAPI]);

  /**
   * 最大化/还原窗口
   */
  const handleMaximize = useCallback(() => {
    if (electronAPI?.window?.maximize) {
      electronAPI.window.maximize();
    } else if (typeof window !== 'undefined' && (window as any).electronAPI?.window?.maximize) {
      (window as any).electronAPI.window.maximize();
    }
  }, [electronAPI]);

  /**
   * 关闭窗口
   */
  const handleClose = useCallback(() => {
    if (electronAPI?.window?.close) {
      electronAPI.window.close();
    } else if (typeof window !== 'undefined' && (window as any).electronAPI?.window?.close) {
      (window as any).electronAPI.window.close();
    }
  }, [electronAPI]);

  return (
    <header className={`${styles['title-bar']} ${className}`}>
      {/* 左侧区域 */}
      <div className={styles['title-bar-left']}>
        {showMenuButton && (
          <button
            className={styles['title-bar-menu-btn']}
            onClick={onMenuClick}
            title="菜单"
            type="button"
          >
            <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2 3h12v1.5H2V3zm0 4.5h12V9H2V7.5zm0 4.5h12v1.5H2V12z" />
            </svg>
          </button>
        )}

        <div className={styles['title-bar-brand']}>
          <span className={styles['title-bar-app-name']}>{appName}</span>
          {title && <span className={styles['title-bar-separator']}>-</span>}
          {title && <span className={styles['title-bar-title-text']}>{title}</span>}
          <span
            className={`${styles['title-bar-status']} ${isConnected ? styles.connected : styles.disconnected}`}
            title={
              connectionStatusTitle
                ?? (isConnected ? '模型已就绪' : '未配置模型（请到设置 → 模型配置）')
            }
          />
          {themeToggle && (
            <div className={styles['title-bar-theme-toggle']}>
              {themeToggle}
            </div>
          )}
        </div>
      </div>

      {/* 可拖拽区域 */}
      <div className={styles['title-bar-drag-region']} />

      {/* 窗口控制按钮 */}
      <div className={styles['title-bar-controls']}>
        <button
          className={`${styles['title-bar-control-btn']} ${styles.minimize}`}
          onClick={handleMinimize}
          title="最小化"
          type="button"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
            <path d="M0 5h10v1H0z" />
          </svg>
        </button>

        <button
          className={`${styles['title-bar-control-btn']} ${styles.maximize}`}
          onClick={handleMaximize}
          title={isMaximized ? '还原' : '最大化'}
          type="button"
        >
          {isMaximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
              <path d="M2 2v6h6V2H2zm5 5H3V3h4v4z" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
              <path d="M0 0v10h10V0H0zm1 1h8v8H1V1z" />
            </svg>
          )}
        </button>

        <button
          className={`${styles['title-bar-control-btn']} ${styles.close}`}
          onClick={handleClose}
          title="关闭"
          type="button"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
            <path d="M1.41 0L5 3.59 8.59 0 10 1.41 6.41 5 10 8.59 8.59 10 5 6.41 1.41 10 0 8.59 3.59 5 0 1.41z" />
          </svg>
        </button>
      </div>
    </header>
  );
};

export default TitleBar;
