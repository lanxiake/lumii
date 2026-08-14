/**
 * SettingsCategoryNav - Hub 设置区左侧分类导航
 */

import React from 'react'
import clsx from 'clsx'
import type { MergedSettingsCategory, SettingsCategoryItem } from './types'
import styles from './SettingsHubModal.module.css'

interface SettingsCategoryNavProps {
  categories: SettingsCategoryItem[]
  activeCategory: MergedSettingsCategory
  onChange: (category: MergedSettingsCategory) => void
}

/**
 * 设置左侧分类列表
 */
export const SettingsCategoryNav: React.FC<SettingsCategoryNavProps> = ({
  categories,
  activeCategory,
  onChange,
}) => {
  return (
    <nav className={styles.categoryNav} aria-label="设置分类">
      {categories.map((item) => (
        <button
          key={item.id}
          type="button"
          className={clsx(styles.categoryItem, activeCategory === item.id && styles.categoryItemActive)}
          onClick={() => onChange(item.id)}
          data-app-ui="hub-category"
        >
          <span className={styles.categoryIcon}>{item.icon}</span>
          <span className={styles.categoryLabel}>{item.label}</span>
        </button>
      ))}
    </nav>
  )
}

export default SettingsCategoryNav
