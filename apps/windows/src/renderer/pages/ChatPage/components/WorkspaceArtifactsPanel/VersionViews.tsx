/**
 * 版本对照 / 只读预览（P2 T3）
 *
 * 只负责展示；版本解析与内容读取在主进程（`artifact:versionDiff/Content`）。
 */

import type { ArtifactVersionDiffResult } from '../../../../../shared/artifact-version-types'
import { DiffHunks } from './DiffHunks'
import styles from './VersionViews.module.css'

export interface VersionDiffViewProps {
  path: string
  fromLabel: string
  toLabel: string
  result: ArtifactVersionDiffResult
  onClose: () => void
}

export const VersionDiffView: React.FC<VersionDiffViewProps> = ({
  path,
  fromLabel,
  toLabel,
  result,
  onClose,
}) => (
  <div className={styles.panel} data-testid="version-diff-view">
    <header className={styles.header}>
      <span className={styles.title}>版本对照</span>
      <span className={styles.subtitle} title={path}>
        {fromLabel} → {toLabel}
      </span>
      {result.ok && (
        <span className={styles.stats}>
          <span className={styles.plus}>+{result.insertions}</span>
          <span className={styles.minus}>−{result.deletions}</span>
        </span>
      )}
      <span className={styles.spacer} />
      <button type="button" className={styles.close} onClick={onClose}>
        关闭
      </button>
    </header>
    {result.ok ? (
      result.hunks.length > 0 ? (
        <DiffHunks hunks={result.hunks} />
      ) : (
        <p className={styles.note}>两版内容相同。</p>
      )
    ) : (
      <p className={styles.error}>{result.reason}</p>
    )}
  </div>
)

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
