import React from 'react'
import { Checkbox } from '../../../../components/ui/Checkbox/Checkbox'
import styles from '../../SettingsPage.module.css'

interface AccountSectionProps {
  openAtLogin: boolean
  openAtLoginLoading: boolean
  showSplashOnStartup: boolean
  onToggleOpenAtLogin: (enable: boolean) => void
  onToggleSplash: (enable: boolean) => void
}

export function AccountSection({
  openAtLogin,
  openAtLoginLoading,
  showSplashOnStartup,
  onToggleOpenAtLogin,
  onToggleSplash,
}: AccountSectionProps) {
  return (
    <div className={styles['settings-section']}>
      <h3 data-app-ui-section-title>通用</h3>

      <h4 className={styles['settings-subsection-title']}>系统偏好</h4>

      <div className={styles['setting-group']}>
        <div className={styles['setting-item']}>
          <Checkbox
            checked={openAtLogin}
            onChange={(checked) => onToggleOpenAtLogin(checked)}
            disabled={openAtLoginLoading}
          >
            开机时自动启动
          </Checkbox>
          <span className={styles['setting-hint']}>登录系统后自动启动灵栖 / Lumii</span>
        </div>
        <div className={styles['setting-item']}>
          <Checkbox
            checked={showSplashOnStartup}
            onChange={(checked) => { void onToggleSplash(checked) }}
          >
            启动时播放开机动画
          </Checkbox>
          <span className={styles['setting-hint']}>
            关闭后主窗口直接进入界面；文件预览等独立窗口本就不播放
          </span>
        </div>
      </div>
    </div>
  )
}
