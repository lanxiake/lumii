/**
 * 版本对照 / 只读预览（P2 T3）
 *
 * 只负责展示；版本解析与内容读取在主进程（`artifact:versionDiff/Content`）。
 */

import type { ArtifactVersionDiffResult } from '../../../../../shared/artifact-version-types'
import { DiffHunks } from './DiffHunks'
import { mediaUrl } from './ledger'
import styles from './VersionViews.module.css'

export interface VersionDiffViewProps {
  path: string
  fromLabel: string
  toLabel: string
  result: ArtifactVersionDiffResult
  /** 图片并排用：物化副本的工作区相对路径 → 绝对路径 */
  toAbsolutePath?: (relativePath: string) => string
  onClose: () => void
}

export const VersionDiffView: React.FC<VersionDiffViewProps> = ({
  path,
  fromLabel,
  toLabel,
  result,
  toAbsolutePath,
  onClose,
}) => {
  const stats = result.ok
    ? result.kind === 'text'
      ? { insertions: result.insertions, deletions: result.deletions }
      : result.kind === 'slides'
        ? {
            insertions: result.pages.reduce((sum, page) => sum + page.insertions, 0),
            deletions: result.pages.reduce((sum, page) => sum + page.deletions, 0),
          }
        : null
    : null

  return (
    <div className={styles.panel} data-testid="version-diff-view">
      <header className={styles.header}>
        <span className={styles.title}>版本对照</span>
        <span className={styles.subtitle} title={path}>
          {fromLabel} → {toLabel}
        </span>
        {stats && (
          <span className={styles.stats}>
            <span className={styles.plus}>+{stats.insertions}</span>
            <span className={styles.minus}>−{stats.deletions}</span>
          </span>
        )}
        <span className={styles.spacer} />
        <button type="button" className={styles.close} onClick={onClose}>
          关闭
        </button>
      </header>
      {!result.ok ? (
        <p className={styles.error}>{result.reason}</p>
      ) : result.kind === 'image' ? (
        <div className={styles.imagePair} data-testid="version-image-compare">
          {[result.from, result.to].map((side) => (
            <figure key={side.path} className={styles.imageCell}>
              {toAbsolutePath ? (
                <img src={mediaUrl(toAbsolutePath(side.path))} alt={side.label} />
              ) : (
                <span className={styles.note}>无法预览这一版</span>
              )}
              <figcaption className={styles.imageLabel}>{side.label}</figcaption>
            </figure>
          ))}
        </div>
      ) : result.kind === 'slides' ? (
        result.pages.length === 0 ? (
          <p className={styles.note}>两版各页文本相同。</p>
        ) : (
          <div className={styles.slidePages} data-testid="version-slides-compare">
            {result.pages.map((page) => (
              <section key={page.index} className={styles.slidePage}>
                <header className={styles.slideHead}>
                  <span className={styles.slideTitle}>
                    第 {page.index + 1} 页{page.title ? ` · ${page.title}` : ''}
                  </span>
                  <span className={styles.stats}>
                    <span className={styles.plus}>+{page.insertions}</span>
                    <span className={styles.minus}>−{page.deletions}</span>
                  </span>
                </header>
                <DiffHunks hunks={page.hunks} />
              </section>
            ))}
            <p className={styles.note}>共 {result.totalPages} 页；只列出文本有变化的页。</p>
          </div>
        )
      ) : result.hunks.length > 0 ? (
        <DiffHunks hunks={result.hunks} />
      ) : (
        <p className={styles.note}>两版内容相同。</p>
      )}
    </div>
  )
}

export interface VersionTextViewProps {
  path: string
  label: string
  text: string
  approximate?: boolean
  onClose: () => void
}

export const VersionTextView: React.FC<VersionTextViewProps> = ({
  path,
  label,
  text,
  approximate = false,
  onClose,
}) => (
  <div className={styles.panel} data-testid="version-text-view">
    <header className={styles.header}>
      <span className={styles.title}>版本预览</span>
      <span className={styles.subtitle} title={path}>
        {label}
      </span>
      {approximate && <span className={styles.warn}>快照可能包含后续改动</span>}
      <span className={styles.spacer} />
      <button type="button" className={styles.close} onClick={onClose}>
        关闭
      </button>
    </header>
    <pre className={styles.text}>{text}</pre>
  </div>
)
