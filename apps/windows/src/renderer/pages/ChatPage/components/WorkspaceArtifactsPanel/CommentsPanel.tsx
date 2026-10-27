/**
 * 工作台评论面板（P2 T8）—— 挂在检查器底部
 *
 * 评论是草稿：列表 / 新增（选区或当前 PPT 页由父层给锚点）/ 删除 / 「带着 N 条评论继续」
 * 只把拼好的文本**预填**到输入框，不发送；真实发送后由 ChatPage 标记已发送。
 */

import React, { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type {
  ArtifactComment,
  CommentAnchor,
} from '../../../../../shared/workbench-comment-types'
import { MAX_COMMENT_TEXT_CHARS } from '../../../../../shared/workbench-comment-types'
import { artifactEditService } from '../../../../services/artifact-edit-service'
import { formatClock } from './ledger'
import styles from './CommentsPanel.module.css'

export interface CommentDraft {
  anchor?: CommentAnchor
  versionId?: string
}

export interface CommentsPanelProps {
  sessionKey: string
  artifactPath: string
  /** 父层请求刷新（新增/删除后） */
  refreshToken?: number
  /** 选区 / PPT 页触发的草稿 */
  draft?: CommentDraft | null
  onDraftConsumed?: () => void
  /** 「带着评论继续」：只预填，不发送 */
  onPrefill?: (text: string, ids: string[]) => void
  onToast?: (message: string, kind?: 'success' | 'error' | 'info') => void
}

function anchorLabel(comment: ArtifactComment): string {
  const anchor = comment.anchor
  if (anchor?.type === 'slide') return `第 ${anchor.index + 1} 页`
  if (anchor?.type === 'text-range') return '选中片段'
  return '整篇'
}

function quoteOf(comment: ArtifactComment): string | undefined {
  const quote = comment.anchor?.quote?.trim()
  if (!quote) return undefined
  return quote.length > 60 ? `${quote.slice(0, 60)}…` : quote
}

export const CommentsPanel: React.FC<CommentsPanelProps> = ({
  sessionKey,
  artifactPath,
  refreshToken = 0,
  draft,
  onDraftConsumed,
  onPrefill,
  onToast,
}) => {
  const [comments, setComments] = useState<readonly ArtifactComment[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  /** 「评论整篇」打开的编辑器（没有锚点草稿时也能写） */
  const [wholeDocOpen, setWholeDocOpen] = useState(false)

  const load = React.useCallback(async () => {
    const result = await artifactEditService.commentsList({ sessionKey, path: artifactPath })
    if (result.ok) setComments(result.comments)
  }, [sessionKey, artifactPath])

  useEffect(() => {
    void load()
  }, [load, refreshToken])

  // 新草稿（选区/PPT 页）到来时清空输入
  useEffect(() => {
    if (draft) setText('')
  }, [draft])

  const save = async (): Promise<void> => {
    const trimmed = text.trim()
    if (!trimmed) return
    setBusy(true)
    try {
      const result = await artifactEditService.commentsSave({
        sessionKey,
        path: artifactPath,
        text: trimmed,
        ...(draft?.versionId ? { versionId: draft.versionId } : {}),
        ...(draft?.anchor ? { anchor: draft.anchor } : {}),
      })
      if (!result.ok) {
        onToast?.(result.error, 'error')
        return
      }
      setText('')
      setWholeDocOpen(false)
      onDraftConsumed?.()
      await load()
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string): Promise<void> => {
    const result = await artifactEditService.commentsDelete({ sessionKey, id })
    if (!result.ok) {
      onToast?.(result.error, 'error')
      return
    }
    await load()
  }

  const composeAndPrefill = async (): Promise<void> => {
    const unsent = comments.filter((comment) => !comment.sentAt)
    if (unsent.length === 0) {
      onToast?.('没有未发送的评论', 'info')
      return
    }
    setBusy(true)
    setNote(null)
    try {
      const result = await artifactEditService.commentsCompose({
        sessionKey,
        path: artifactPath,
        ids: unsent.map((comment) => comment.id),
      })
      if (!result.ok) {
        onToast?.(result.error, 'error')
        return
      }
      onPrefill?.(result.text, result.ids)
      if (result.truncated) {
        setNote(`一次最多带 ${result.count} 条 / 2000 字，其余已保留，可发送后继续。`)
      }
      onToast?.('已把评论预填到输入框（未发送）', 'success')
    } finally {
      setBusy(false)
    }
  }

  const unsentCount = comments.filter((comment) => !comment.sentAt).length

  return (
    <section className={styles.panel} data-testid="comments-panel">
      <div className={styles.head}>
        <span className={styles.title}>评论</span>
        <span className={styles.count}>
          {comments.length > 0 ? `${comments.length} 条` : '暂无'}
          {unsentCount > 0 ? ` · 未发送 ${unsentCount}` : ''}
        </span>
      </div>

      {comments.length > 0 && (
        <ul className={styles.list}>
          {comments.map((comment) => (
            <li key={comment.id} className={styles.row}>
              <div className={styles.rowHead}>
                <span className={styles.anchor}>{anchorLabel(comment)}</span>
                <span className={styles.time}>{formatClock(comment.createdAt)}</span>
                {comment.sentAt && <span className={styles.sent}>已发送</span>}
                <button
                  type="button"
                  className={styles.delete}
                  onClick={() => void remove(comment.id)}
                  title="删除这条评论"
                  aria-label="删除评论"
                >
                  <Trash2 size={11} strokeWidth={2} />
                </button>
              </div>
              {quoteOf(comment) && (
                <div className={styles.quote} title={quoteOf(comment)}>
                  “{quoteOf(comment)}”
                </div>
              )}
              <div className={styles.text}>{comment.text}</div>
            </li>
          ))}
        </ul>
      )}

      {(draft || wholeDocOpen || text) && (
        <div className={styles.editor}>
          <textarea
            className={styles.textarea}
            aria-label="评论内容"
            value={text}
            maxLength={MAX_COMMENT_TEXT_CHARS}
            placeholder={draft?.anchor ? '对这段内容的修改意见…' : '对整篇的修改意见…'}
            autoFocus
            onChange={(event) => setText(event.target.value)}
          />
          <div className={styles.editorActions}>
            <span className={styles.muted}>
              {draft?.anchor?.type === 'slide'
                ? `第 ${draft.anchor.index + 1} 页`
                : draft?.anchor?.type === 'text-range'
                  ? '选中的片段'
                  : '整篇'}
              {' · '}
              {text.length}/{MAX_COMMENT_TEXT_CHARS}
            </span>
            <button
              type="button"
              className={styles.primary}
              disabled={busy || !text.trim()}
              onClick={() => void save()}
            >
              保存评论
            </button>
          </div>
        </div>
      )}

      {note && <div className={styles.note}>{note}</div>}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => {
            onDraftConsumed?.()
            setText('')
            setWholeDocOpen(true)
          }}
          title="针对整篇添加评论"
        >
          评论整篇
        </button>
        <button
          type="button"
          className={styles.primary}
          disabled={busy || unsentCount === 0}
          onClick={() => void composeAndPrefill()}
          title="把未发送的评论拼成一段文本，预填到输入框（不自动发送）"
        >
          带着 {unsentCount} 条评论继续
        </button>
      </div>
    </section>
  )
}
