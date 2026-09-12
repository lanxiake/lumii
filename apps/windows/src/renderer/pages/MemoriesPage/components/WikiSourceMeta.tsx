/**
 * WikiSourceMeta - 显示资料的元数据（用户路径、标签、描述）
 */

import React from 'react'
import styles from './WikiSourceMeta.module.css'

interface WikiSourceMetaProps {
  userPath?: string[] | null
  tags?: string[] | null
  description?: string | null
  compact?: boolean
}

export const WikiSourceMeta: React.FC<WikiSourceMetaProps> = ({
  userPath,
  tags,
  description,
  compact = false,
}) => {
  const hasAnyMeta = userPath?.length || tags?.length || description

  if (!hasAnyMeta) return null

  return (
    <div className={styles['wiki-source-meta']}>
      {/* 用户路径 - 面包屑 */}
      {userPath && userPath.length > 0 && (
        <div className={styles['wiki-source-meta-path']}>
          <span className={styles['wiki-source-meta-label']}>路径:</span>
          {userPath.map((segment, index) => (
            <React.Fragment key={index}>
              {index > 0 && <span className={styles['wiki-source-meta-separator']}>/</span>}
              <span className={styles['wiki-source-meta-segment']}>{segment}</span>
            </React.Fragment>
          ))}
        </div>
      )}

      {/* 标签 */}
      {tags && tags.length > 0 && (
        <div className={styles['wiki-source-meta-tags']}>
          <span className={styles['wiki-source-meta-label']}>标签:</span>
          {tags.map((tag, index) => (
            <span key={index} className={styles['wiki-source-meta-tag']}>
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* 描述 */}
      {description && !compact && (
        <div className={styles['wiki-source-meta-description']}>
          <span className={styles['wiki-source-meta-label']}>描述:</span>
          <span className={styles['wiki-source-meta-description-text']}>{description}</span>
        </div>
      )}
    </div>
  )
}
