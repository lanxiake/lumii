import React from 'react'

import styles from './PluginPage.module.css'

/**
 * 插件整页的外壳（宿主提供，插件通过 `api.Page` 使用）。
 *
 * 与内置页同口径：占满内容区、`--mt-page-max` 居中、标题/副标题/操作区。
 * **不额外加内边距**——`.main-layout-content-inner` 已经有 20px，
 * 插件再写 `padding: 24` 实际会变成 44px（示例插件此前就是这样，看起来比内置页胖一圈）。
 *
 * 内容区自己滚动：插件页通常要整页布局，不该让外层滚动条出现两条。
 */
export interface PluginPageProps {
  title?: React.ReactNode
  subtitle?: React.ReactNode
  /** 标题右侧的操作按钮等 */
  actions?: React.ReactNode
  children?: React.ReactNode
}

export const PluginPage: React.FC<PluginPageProps> = ({ title, subtitle, actions, children }) => {
  const hasHeader = Boolean(title || subtitle || actions)
  return (
    <div className={styles.page}>
      {hasHeader && (
        <header className={styles.header}>
          <div className={styles.heading}>
            {title && <h1 className={styles.title}>{title}</h1>}
            {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          </div>
          {actions && <div className={styles.actions}>{actions}</div>}
        </header>
      )}
      <div className={styles.body}>{children}</div>
    </div>
  )
}
