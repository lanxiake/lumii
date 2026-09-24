/**
 * AppearanceSection - 外观设置
 *
 * 主题四选一：浅色 / 护眼 / 深色 / 跟随系统。
 * 直接走 ThemeContext 的 setTheme（内部负责写 localStorage、data-theme 与系统主题监听），
 * 不经 useSettings 的存储层，避免两套持久化互相覆盖。
 */

import React from 'react'
import { useTheme, type Theme } from '../../../../contexts/ThemeContext/ThemeContext'
import settingsStyles from '../../SettingsPage.module.css'
import styles from './AppearanceSection.module.css'

interface ThemeOption {
  value: Theme
  label: string
  hint: string
  /** 预览色块：画布 / 卡片 / 强调色 */
  swatch: [string, string, string]
}

const THEME_OPTIONS: ThemeOption[] = [
  {
    value: 'light',
    label: '浅色',
    hint: '冷调蓝白，对比清晰',
    swatch: ['#f3f5f9', '#ffffff', '#2a76f6'],
  },
  {
    value: 'eye-care',
    label: '护眼',
    hint: '米黄暖色，降低蓝光，久看更舒适',
    swatch: ['#f5f1e8', '#fffdf7', '#b8863b'],
  },
  {
    value: 'dark',
    label: '深色',
    hint: '暗色画布，夜间使用',
    swatch: ['#0f172a', '#1e293b', '#3b82f6'],
  },
  {
    value: 'system',
    label: '跟随系统',
    hint: '随系统深浅色自动切换',
    swatch: ['#f3f5f9', '#0f172a', '#64748b'],
  },
]

export function AppearanceSection() {
  const { theme, setTheme } = useTheme()

  return (
    <div className={settingsStyles['settings-section']}>
      <div className={settingsStyles['setting-row']}>
        <span className={settingsStyles['setting-label']}>主题</span>
        <div className={styles['theme-switch']} role="radiogroup" aria-label="界面主题">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={theme === option.value}
              className={theme === option.value ? styles['theme-switch-active'] : undefined}
              onClick={() => setTheme(option.value)}
              title={option.hint}
            >
              <span className={styles.swatch} aria-hidden>
                {option.swatch.map((color) => (
                  <i key={color} style={{ background: color }} />
                ))}
              </span>
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <p className={settingsStyles['setting-hint']}>
        护眼主题用米黄画布与琥珀强调色替代冷调蓝白，减少蓝光。选择立即生效并记住；
        「跟随系统」按操作系统的深浅色设置自动切换（护眼只在手动选择时生效）。
      </p>
    </div>
  )
}
