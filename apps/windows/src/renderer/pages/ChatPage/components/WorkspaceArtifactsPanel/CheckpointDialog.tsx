/**
 * 「恢复到这一轮」对话框（P2 T7）
 *
 * 打开即拉计划（只读），列出「将恢复 / 移入回收站 / 跳过（原因）」三类，
 * 勾选「同时从此轮分支对话」（默认勾选）。恢复完成后给结果摘要与撤销入口。
 *
 * 固定文案（§4.6）：只恢复本会话记录的工作区文件；不恢复配置、依赖、环境变量
 * 与数据库；对话会从此轮分支，原会话保留。
 */

import React, { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type {
  CheckpointApplyResult,
  CheckpointPlan,
} from '../../../../../shared/artifact-checkpoint-types'
import { artifactEditService } from '../../../../services/artifact-edit-service'
import { formatClock } from './ledger'
import styles from './CheckpointDialog.module.css'

export interface CheckpointDialogProps {
  sessionKey: string
  turnId: string
  onClose: () => void
  /** 恢复/撤销完成后通知上层（可带新会话 key 供切换） */
  onApplied?: (result: CheckpointApplyResult, meta?: { undone?: boolean }) => void
}

function fileNameOf(filePath: string): string {
  return filePath.split('/').pop() ?? filePath
}

const NOTICE =
  '只恢复本会话记录的工作区文件；不恢复配置、依赖、环境变量与数据库；对话会从此轮分支，原会话保留。'

export const CheckpointDialog: React.FC<CheckpointDialogProps> = ({
  sessionKey,
  turnId,
  onClose,
  onApplied,
}) => {
  // 恢复会创建分支并切会话；对话框只认打开时的会话，别被切换后的 sessionKey 带着重查
  const [targetSession] = useState(sessionKey)
  const [plan, setPlan] = useState<CheckpointPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [branch, setBranch] = useState(true)
  const [result, setResult] = useState<CheckpointApplyResult | null>(null)
  const [undoNote, setUndoNote] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void artifactEditService
      .checkpointPlan({ sessionKey: targetSession, turnId })
      .then((res) => {
        if (cancelled) return
        if (res.ok) setPlan(res.plan)
        else setError(res.error)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '读取恢复计划失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [targetSession, turnId])

  const apply = async (): Promise<void> => {
    if (!plan) return
    setBusy(true)
    try {
      const res = await artifactEditService.checkpointApply({
        sessionKey: targetSession,
        turnId,
        restoreConversation: branch && plan.canRestoreConversation,
      })
      if (!res.ok) {
        setError(res.error)
        return
      }
      setResult(res)
      onApplied?.(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : '恢复失败')
    } finally {
      setBusy(false)
    }
  }

  const undo = async (): Promise<void> => {
    if (!result) return
    setBusy(true)
    try {
      const res = await artifactEditService.checkpointUndo(result.checkpointId)
      if (!res.ok) {
        setUndoNote(res.error)
        return
      }
      setUndoNote(
        `已撤销：回退 ${res.restored} 个文件，回收站放回 ${res.restoredFromTrash} 个` +
          (res.warnings && res.warnings.length > 0 ? `（${res.warnings.join('；')}）` : ''),
      )
      onApplied?.(result, { undone: true })
    } catch (err) {
      setUndoNote(err instanceof Error ? err.message : '撤销失败')
    } finally {
      setBusy(false)
    }
  }

  const restore = plan?.files.filter((file) => file.action === 'restore') ?? []
  const trash = plan?.files.filter((file) => file.action === 'trash') ?? []
  const skipped = plan?.files.filter((file) => file.action === 'skip') ?? []

  return (
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label="恢复到这一轮">
      <div className={styles.dialog}>
        <header className={styles.header}>
          <span className={styles.title}>
            恢复到这一轮
            {plan && ` · ${formatClock(plan.anchor.timestamp)}`}
          </span>
          <button type="button" className={styles.close} onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>

        <p className={styles.notice}>{NOTICE}</p>
        {error && <div className={styles.error}>{error}</div>}

        {loading ? (
          <div className={styles.loading}>
            <Loader2 size={13} className={styles.spin} aria-hidden="true" /> 正在读取恢复计划…
          </div>
        ) : plan ? (
          <div className={styles.body}>
            {plan.warnings?.map((warning) => (
              <div key={warning} className={styles.warning}>
                {warning}
              </div>
            ))}

            <section className={styles.section}>
              <div className={styles.sectionTitle}>
                将恢复 {restore.length} 个文件
              </div>
              {restore.length === 0 ? (
                <div className={styles.empty}>没有需要恢复的文件。</div>
              ) : (
                <ul className={styles.list}>
                  {restore.map((file) => (
                    <li key={file.path} className={styles.row}>
                      <span className={styles.path} title={file.path}>
                        {fileNameOf(file.path)}
                      </span>
                      <span className={styles.tag}>
                        {file.content === 'git'
                          ? '文本快照'
                          : file.content === 'pin'
                            ? '固化副本'
                            : file.storeMessageId
                              ? '本轮文本副本'
                              : '本地编辑副本'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className={styles.section}>
              <div className={styles.sectionTitle}>
                移入回收站 {trash.length} 个文件（这一轮之后新增）
              </div>
              {trash.length === 0 ? (
                <div className={styles.empty}>没有需要移走的文件。</div>
              ) : (
                <ul className={styles.list}>
                  {trash.map((file) => (
                    <li key={file.path} className={styles.row}>
                      <span className={styles.path} title={file.path}>
                        {fileNameOf(file.path)}
                      </span>
                      <span className={styles.tagMuted}>可恢复</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {skipped.length > 0 && (
              <section className={styles.section}>
                <div className={styles.sectionTitle}>跳过 {skipped.length} 个文件</div>
                <ul className={styles.list}>
                  {skipped.map((file) => (
                    <li key={file.path} className={styles.row}>
                      <span className={styles.path} title={file.path}>
                        {fileNameOf(file.path)}
                      </span>
                      <span className={styles.skipReason} title={file.reason}>
                        {file.reason ?? '无法恢复'}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <label className={styles.branchRow}>
              <input
                type="checkbox"
                checked={branch && plan.canRestoreConversation}
                disabled={!plan.canRestoreConversation}
                onChange={(event) => setBranch(event.target.checked)}
              />
              同时从此轮分支对话（原会话保留）
              {!plan.canRestoreConversation && (
                <span className={styles.muted}>（当前版本不支持分支）</span>
              )}
            </label>

            {result && (
              <div className={styles.result}>
                <div>
                  已恢复 {result.restored} 个、移入回收站 {result.trashed} 个、跳过{' '}
                  {result.skipped} 个。
                  {result.newSessionKey ? '已创建对话分支。' : ''}
                </div>
                {result.warnings?.map((warning) => (
                  <div key={warning} className={styles.warning}>
                    {warning}
                  </div>
                ))}
                {undoNote ? (
                  <div className={styles.undoNote}>{undoNote}</div>
                ) : (
                  <button
                    type="button"
                    className={styles.undoBtn}
                    onClick={() => void undo()}
                    disabled={busy}
                  >
                    撤销这次恢复
                  </button>
                )}
              </div>
            )}
          </div>
        ) : null}

        <footer className={styles.footer}>
          {!result && (
            <button
              type="button"
              className={styles.primary}
              onClick={() => void apply()}
              disabled={!plan || busy || (restore.length === 0 && trash.length === 0 && !branch)}
            >
              {busy ? '恢复中…' : '恢复'}
            </button>
          )}
          <button type="button" className={styles.secondary} onClick={onClose} disabled={busy}>
            {result ? '关闭' : '取消'}
          </button>
        </footer>
      </div>
    </div>
  )
}
