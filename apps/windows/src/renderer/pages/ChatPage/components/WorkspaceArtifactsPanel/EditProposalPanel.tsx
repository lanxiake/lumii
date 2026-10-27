/**
 * 就地修改的「提议 → 预览 → 应用」面板（P2 T2）
 *
 * 只负责展示候选 diff 与三个动作；生成/应用/冲突都由调用方通过服务处理。
 */

import type { ArtifactEditProposal } from '../../../../../shared/artifact-edit-types'
import { DiffHunks } from './DiffHunks'
import styles from './EditProposalPanel.module.css'

export interface EditProposalPanelProps {
  status: 'loading' | 'ready' | 'error'
  proposal?: ArtifactEditProposal | null
  error?: string | null
  busy?: boolean
  /** 无 diff 时的说明（PPT 候选预览） */
  hint?: string
  /** 头部作用域说明；默认「只替换选中区间」 */
  scopeHint?: string
  onApply: () => void
  onDiscard: () => void
  onCancel: () => void
}

export const EditProposalPanel: React.FC<EditProposalPanelProps> = ({
  status,
  proposal,
  error,
  busy = false,
  hint,
  scopeHint,
  onApply,
  onDiscard,
  onCancel,
}) => {
  if (status === 'loading') {
    return (
      <div className={styles.panel} data-testid="edit-proposal-loading">
        <div className={styles.header}>
          <span className={styles.title}>正在生成改写建议…</span>
          <button type="button" className={styles.ghostBtn} onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className={styles.panel} data-testid="edit-proposal-error">
        <div className={styles.header}>
          <span className={styles.title}>改写失败</span>
          <button type="button" className={styles.ghostBtn} onClick={onDiscard}>
            关闭
          </button>
        </div>
        <p className={styles.error}>{error ?? '未知错误'}</p>
      </div>
    )
  }

  const diff = proposal?.diff
  return (
    <div className={styles.panel} data-testid="edit-proposal-ready">
      <div className={styles.header}>
        <span className={styles.title}>改写建议</span>
        <span className={styles.hint}>
          {scopeHint ?? '只替换选中区间；应用前不会写盘'}
        </span>
        {diff && (
          <span className={styles.stats}>
            <span className={styles.plus}>+{diff.insertions}</span>
            <span className={styles.minus}>−{diff.deletions}</span>
          </span>
        )}
        <span className={styles.spacer} />
        <button type="button" className={styles.ghostBtn} onClick={onDiscard} disabled={busy}>
          放弃
        </button>
        <button type="button" className={styles.primaryBtn} onClick={onApply} disabled={busy}>
          {busy ? '应用中…' : '应用'}
        </button>
      </div>

      {diff && diff.hunks.length > 0 ? (
        <DiffHunks hunks={diff.hunks} />
      ) : (
        <p className={styles.empty}>{hint ?? '候选稿已生成，暂无逐行差异。'}</p>
      )}
    </div>
  )
}
