import React from 'react'
import styles from './ArtifactToolbar.module.css'

export interface ArtifactToolbarProps {
  language?: string
  onCopy: () => void
  onTogglePreview: () => void
  onToggleFullscreen: () => void
  onRerun: () => void
  previewActive: boolean
  fullscreen: boolean
}

export function ArtifactToolbar({
  language,
  onCopy,
  onTogglePreview,
  onToggleFullscreen,
  onRerun,
  previewActive,
  fullscreen,
}: ArtifactToolbarProps) {
  const isPreviewable = ['html', 'javascript', 'js', 'svg'].includes(language?.toLowerCase() ?? '')

  return (
    <div className={styles['toolbar']}>
      {language && <span className={styles['toolbar-lang']}>{language}</span>}
      <div className={styles['toolbar-actions']}>
        {isPreviewable && (
          <>
            <button
              className={`${styles['toolbar-btn']} ${previewActive ? styles['toolbar-btn-active'] : ''}`}
              onClick={onTogglePreview}
              title={previewActive ? '查看源码' : '预览'}
            >
              {previewActive ? '源码' : '预览'}
            </button>
            {previewActive && (
              <>
                <button
                  className={styles['toolbar-btn']}
                  onClick={onRerun}
                  title="重新运行"
                >
                  重新运行
                </button>
                <button
                  className={`${styles['toolbar-btn']} ${fullscreen ? styles['toolbar-btn-active'] : ''}`}
                  onClick={onToggleFullscreen}
                  title={fullscreen ? '退出全屏' : '全屏'}
                >
                  {fullscreen ? '退出全屏' : '全屏'}
                </button>
              </>
            )}
          </>
        )}
        <button
          className={styles['toolbar-btn']}
          onClick={onCopy}
          title="复制代码"
        >
          复制
        </button>
      </div>
    </div>
  )
}
