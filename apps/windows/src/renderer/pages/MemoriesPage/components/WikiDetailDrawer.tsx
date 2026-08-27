/**
 * WikiDetailDrawer — 在页面列表上方展示 Wiki 详情与编辑能力。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import MDEditor from '@uiw/react-md-editor'
import { Trash2, X } from 'lucide-react'
import { Button } from '../../../components/ui/Button/Button'
import type {
  WikiBacklinkItem,
  WikiPageDetail,
  WikiPageListItem,
  WikiRevisionItem,
} from '../../../hooks/business/useWikiPage'
import { LinkAutocomplete, detectWikilinkTrigger } from './LinkAutocomplete'
import { PageSidebar } from './PageSidebar'
import { uploadFilesForWikiAttachment } from './wikiAttachmentUpload'

interface WikiDetailDrawerProps {
  readonly open: boolean
  readonly page: WikiPageDetail | null
  readonly pages: readonly WikiPageListItem[]
  readonly isEditing: boolean
  readonly editTitle: string
  readonly editDraft: string
  readonly onEditTitleChange: (title: string) => void
  readonly onEditDraftChange: React.Dispatch<React.SetStateAction<string>>
  readonly onStartEdit: () => void
  readonly onCancelEdit: () => void
  readonly onSaveEdit: () => void
  readonly onRequestDelete: () => void
  readonly onClose: () => void
  readonly listBacklinks: (pageId: string) => Promise<readonly WikiBacklinkItem[]>
  readonly listRevisions: (pageId: string) => Promise<readonly WikiRevisionItem[]>
  readonly rollbackPage: (pageId: string, targetVersion: number) => Promise<unknown>
  readonly onOpenPage: (pageId: string) => void
  readonly onRolledBack: () => void
}

/**
 * 将时间戳格式化为中文本地时间。
 */
function formatTime(timestamp: number | null): string {
  if (!timestamp) return ''
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

/**
 * 在编辑器光标处完成 Wiki 链接自动补全。
 */
function insertWikilinkAtCursor(
  textarea: HTMLTextAreaElement,
  currentValue: string,
  title: string,
): string {
  const cursor = textarea.selectionStart
  const before = currentValue.slice(0, cursor)
  const after = currentValue.slice(cursor)
  const lastOpen = before.lastIndexOf('[[')
  if (lastOpen === -1) return currentValue
  return `${before.slice(0, lastOpen)}[[${title}]]${after}`
}

/**
 * 渲染覆盖于列表上的 Wiki 页面详情抽屉。
 */
export const WikiDetailDrawer: React.FC<WikiDetailDrawerProps> = ({
  open,
  page,
  pages,
  isEditing,
  editTitle,
  editDraft,
  onEditTitleChange,
  onEditDraftChange,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onRequestDelete,
  onClose,
  listBacklinks,
  listRevisions,
  rollbackPage,
  onOpenPage,
  onRolledBack,
}) => {
  const [isDragOver, setIsDragOver] = useState(false)
  const [linkQuery, setLinkQuery] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (!open) return undefined

    /** 按 Escape 键关闭当前详情抽屉。 */
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  useEffect(() => {
    setIsDragOver(false)
    setLinkQuery(null)
  }, [page?.id])

  /**
   * 同步编辑内容并检测 Wiki 链接自动补全触发词。
   */
  const handleEditChange = useCallback(
    (value: string | undefined, event?: React.ChangeEvent<HTMLTextAreaElement>) => {
      const nextValue = value ?? ''
      onEditDraftChange(nextValue)
      if (event?.target) textareaRef.current = event.target
      const cursor = event?.target?.selectionStart ?? nextValue.length
      setLinkQuery(detectWikilinkTrigger(nextValue.slice(0, cursor)))
    },
    [onEditDraftChange],
  )

  /**
   * 将选中的 Wiki 页面标题插入当前编辑器光标位置。
   */
  const handleSelectWikilink = useCallback(
    (selectedPage: WikiPageListItem) => {
      const textarea = textareaRef.current
      if (!textarea) return
      onEditDraftChange(insertWikilinkAtCursor(textarea, editDraft, selectedPage.title))
      setLinkQuery(null)
    },
    [editDraft, onEditDraftChange],
  )

  /**
   * 上传拖入编辑器的附件并追加 Markdown 引用。
   */
  const handleAttachmentDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault()
      setIsDragOver(false)
      if (!isEditing || event.dataTransfer.files.length === 0) return
      const uploaded = await uploadFilesForWikiAttachment(event.dataTransfer.files)
      if (uploaded.length === 0) return
      const lines = uploaded.map((item) => item.referenceLine).join('\n')
      onEditDraftChange((currentDraft) => (
        currentDraft ? `${currentDraft}\n${lines}` : lines
      ))
    },
    [isEditing, onEditDraftChange],
  )

  /**
   * 编辑状态下接管文件拖拽并显示投放反馈。
   */
  const handleDragOver = useCallback(
    (event: React.DragEvent) => {
      if (!isEditing) return
      event.preventDefault()
      setIsDragOver(true)
    },
    [isEditing],
  )

  if (!open || !page) return null

  return (
    <div className="wiki-detail-overlay">
      <button
        type="button"
        className="wiki-detail-mask"
        aria-label="关闭详情"
        onClick={onClose}
      />
      <aside
        className="wiki-detail-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wiki-detail-title"
      >
        <div className="wiki-page-view">
          <div className="wiki-page-view-header">
            {isEditing ? (
              <input
                className="wiki-page-title-input"
                aria-label="页面标题"
                value={editTitle}
                onChange={(event) => onEditTitleChange(event.target.value)}
              />
            ) : (
              <h2 id="wiki-detail-title">{page.title}</h2>
            )}
            <div className="wiki-page-view-actions">
              {isEditing ? (
                <>
                  <Button variant="primary" size="sm" onClick={onSaveEdit}>保存</Button>
                  <Button variant="secondary" size="sm" onClick={onCancelEdit}>取消</Button>
                </>
              ) : (
                <>
                  <Button variant="secondary" size="sm" onClick={onStartEdit}>编辑</Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="删除页面"
                    onClick={onRequestDelete}
                  >
                    <Trash2 size={12} />
                  </Button>
                </>
              )}
              <Button variant="ghost" size="sm" aria-label="关闭" onClick={onClose}>
                <X size={16} />
              </Button>
            </div>
          </div>
          <p className="wiki-page-view-meta">
            {page.path} · v{page.version} · {formatTime(page.updatedAt)}
          </p>
          <div
            className={`wiki-page-view-editor${isDragOver ? ' wiki-page-view-editor--dragover' : ''}`}
            onDrop={(event) => void handleAttachmentDrop(event)}
            onDragOver={handleDragOver}
            onDragLeave={() => setIsDragOver(false)}
          >
            <MDEditor
              value={isEditing ? editDraft : page.contentMd}
              onChange={handleEditChange}
              preview={isEditing ? 'live' : 'preview'}
              height="100%"
              visibleDragbar={false}
              hideToolbar={!isEditing}
            />
            {linkQuery !== null && (
              <LinkAutocomplete
                query={linkQuery}
                pages={pages}
                onSelect={handleSelectWikilink}
                onDismiss={() => setLinkQuery(null)}
              />
            )}
          </div>
        </div>
        <PageSidebar
          pageId={page.id}
          currentContentMd={isEditing ? editDraft : page.contentMd}
          listBacklinks={listBacklinks}
          listRevisions={listRevisions}
          rollbackPage={rollbackPage}
          onOpenPage={onOpenPage}
          onRolledBack={onRolledBack}
        />
      </aside>
    </div>
  )
}

export default WikiDetailDrawer
