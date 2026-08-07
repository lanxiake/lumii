/**
 * SessionFileList — 当前会话文件列表（可折叠）
 *
 * 职责：
 * - 汇总当前会话中 Agent 生成 / 通道接收的所有文件（来自 agent-runtime-store 的 fileEvents）
 * - inline 模式：对话流内 Files Changed 风格轻量卡片，点击定位工作空间并预览
 * - 提供预览、打开、另存为（下载）、删除操作（default / compact）
 *
 * 使用：
 * - 放置在对话消息流中（variant=inline）
 * - 空列表时自动隐藏
 */

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import clsx from 'clsx'
import { createPortal } from 'react-dom'
import { FilePreviewModal } from '../../../../components/FilePreviewModal/FilePreviewModal'
import { ConfirmModal } from '../../../../components/ui/Modal/ConfirmModal'
import { useWorkspace } from '../../../../hooks/business/useWorkspace'
import {
  updateSessionState,
  type RuntimeFileEvent,
} from '../../../../hooks/business/useAgentRuntime/agent-runtime-store'
import styles from './SessionFileList.module.css'

/** composer 列表默认展示行数，其余收入「显示更多」 */
const COMPOSER_VISIBLE_COUNT = 5

export interface SessionFileListProps {
  /** 当前会话的全部文件事件（来自 runtimeStore.fileEvents，按 conversationId 分组后传入） */
  files: readonly RuntimeFileEvent[]
  userId?: string
  /** 当前会话 key，删除成功后用于从 runtimeStore 移除对应 fileEvents */
  sessionKey: string | null
  /** 默认是否展开（composer / default） */
  defaultExpanded?: boolean
  /** 紧凑模式：仅显示小图标，悬停时弹出完整列表 */
  compact?: boolean
  /**
   * inline：对话流内 Files Changed 轻量卡片
   * composer / rail：与 inline 同款（兼容旧调用）
   * default：带操作按钮的完整列表
   */
  variant?: 'default' | 'rail' | 'composer' | 'inline'
  /** 「查看」回调：定位到列表中的文件（通常为最新一条） */
  onReview?: (file: RuntimeFileEvent) => void
  /** 点击文件行：打开工作空间定位并预览 */
  onFileOpen?: (file: RuntimeFileEvent) => void
}

/** 格式化文件大小（B / KB / MB） */
function formatSize(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 根据扩展名返回简洁类型徽章（对齐 PR Files Changed 视觉） */
function getExtBadge(fileName: string): { label: string; tone: 'ts' | 'css' | 'js' | 'md' | 'pdf' | 'img' | 'default' } {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.module.css') || lower.endsWith('.css') || lower.endsWith('.scss')) {
    return { label: '#', tone: 'css' }
  }
  const ext = fileName.includes('.') ? (fileName.split('.').pop() ?? '').toLowerCase() : ''
  if (ext === 'ts' || ext === 'tsx') return { label: 'TS', tone: 'ts' }
  if (ext === 'js' || ext === 'jsx' || ext === 'mjs') return { label: 'JS', tone: 'js' }
  if (ext === 'md' || ext === 'markdown') return { label: 'MD', tone: 'md' }
  if (ext === 'pdf') return { label: 'PDF', tone: 'pdf' }
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return { label: 'IMG', tone: 'img' }
  if (ext === 'json') return { label: '{}', tone: 'default' }
  if (ext === 'py') return { label: 'PY', tone: 'default' }
  if (ext === 'html' || ext === 'htm') return { label: '<>', tone: 'default' }
  return { label: (ext || 'FILE').slice(0, 4).toUpperCase(), tone: 'default' }
}

/** 根据文件 MIME / 扩展名返回图标 emoji（default 模式） */
function getFileIcon(mimeType: string | null, fileName: string): string {
  if (!mimeType) {
    const ext = fileName.split('.').pop()?.toLowerCase()
    const extMap: Record<string, string> = {
      pdf: '📕',
      doc: '📘',
      docx: '📘',
      txt: '📄',
      zip: '📦',
      tar: '📦',
      gz: '📦',
      mp4: '🎬',
      mp3: '🎵',
      wav: '🎵',
    }
    return extMap[ext ?? ''] ?? '📎'
  }
  if (mimeType.startsWith('image/')) return '🖼️'
  if (mimeType === 'application/pdf') return '📕'
  if (mimeType === 'application/msword' || mimeType.includes('wordprocessingml')) return '📘'
  if (mimeType.startsWith('text/')) return '📄'
  if (mimeType === 'application/json') return '📋'
  if (mimeType.includes('zip') || mimeType.includes('tar')) return '📦'
  if (mimeType.startsWith('video/')) return '🎬'
  if (mimeType.startsWith('audio/')) return '🎵'
  return '📎'
}

/**
 * 是否可在应用内预览（与 FilePreviewModal / IPC 预览能力对齐）
 */
function isPreviewable(mimeType: string | null, fileName: string): boolean {
  const name = fileName.toLowerCase()
  if (mimeType) {
    if (mimeType.startsWith('image/')) return true
    if (mimeType.startsWith('text/')) return true
    if (mimeType.startsWith('audio/') || mimeType.startsWith('video/')) return true
    if (
      mimeType === 'application/json' ||
      mimeType === 'application/javascript' ||
      mimeType === 'application/xml'
    ) {
      return true
    }
    if (mimeType === 'application/pdf') return true
    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      return true
    }
    if (mimeType === 'application/msword') return true
    if (
      mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mimeType === 'application/vnd.ms-excel'
    ) {
      return true
    }
    if (
      mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
      mimeType === 'application/vnd.ms-powerpoint'
    ) {
      return true
    }
  }
  const ext = name.includes('.') ? (name.split('.').pop() ?? '') : ''
  return [
    'txt', 'md', 'json', 'pdf', 'doc', 'docx',
    'xls', 'xlsx', 'ppt', 'pptx',
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
    'htm', 'html', 'css', 'js', 'ts', 'tsx', 'jsx',
    'mp3', 'wav', 'ogg', 'm4a', 'mp4', 'webm',
  ].includes(ext)
}

/** 单个文件行（default / compact 完整操作） */
const FileRow: React.FC<{
  file: RuntimeFileEvent
  userId: string
  sessionKey: string | null
}> = ({ file, userId, sessionKey }) => {
  const [previewing, setPreviewing] = useState(false)
  const [isOpening, setIsOpening] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const { toAbsolutePath } = useWorkspace()

  const canPreview = isPreviewable(file.mimeType, file.fileName)
  const icon = getFileIcon(file.mimeType, file.fileName)
  const sizeText = formatSize(file.fileSize)

  useEffect(() => {
    if (!menuPos) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuPos(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuPos])

  const handleCopy = useCallback((kind: 'name' | 'relative' | 'absolute') => {
    let text = file.fileName
    if (kind === 'relative') {
      text = file.localPath
    } else if (kind === 'absolute') {
      text = toAbsolutePath(file.localPath).replace(/\\/g, '/')
    }
    void navigator.clipboard.writeText(text).catch((err) => {
      console.error('[SessionFileList] 复制失败:', err)
    })
    setMenuPos(null)
  }, [file.fileName, file.localPath, toAbsolutePath])

  const handleDragStart = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    const absolutePath = toAbsolutePath(file.localPath).replace(/\\/g, '/')
    const payload = JSON.stringify({
      relativePath: file.localPath.replace(/\\/g, '/'),
      name: file.fileName,
      absolutePath,
      isDirectory: false,
    })
    e.dataTransfer.setData('application/x-mtbot-file', payload)
    e.dataTransfer.setData('text/plain', `@${file.localPath.replace(/\\/g, '/')}`)
    e.dataTransfer.effectAllowed = 'copy'
  }, [file.fileName, file.localPath, toAbsolutePath])

  /** 用系统默认应用打开文件 */
  const handleOpen = useCallback(async () => {
    setIsOpening(true)
    setError(null)
    try {
      await window.electronAPI.agentRuntime.sendCommand({
        type: 'files:open',
        fileId: file.fileId,
        userId,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : '打开失败')
    } finally {
      setIsOpening(false)
    }
  }, [file.fileId, userId])

  /** 弹出保存对话框，下载/另存文件到用户选定位置 */
  const handleSaveAs = useCallback(async () => {
    setIsSaving(true)
    setError(null)
    try {
      const result = await window.electronAPI.dialog?.showSaveDialog?.({
        defaultPath: file.fileName,
      })
      const savePath = result?.filePath
      if (savePath) {
        await window.electronAPI.agentRuntime.sendCommand({
          type: 'files:save-as',
          fileId: file.fileId,
          userId,
          savePath,
        })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setIsSaving(false)
    }
  }, [file.fileId, file.fileName, userId])

  /** 软删除数据库记录并从当前会话的 fileEvents 中移除 */
  const handleConfirmDelete = useCallback(async () => {
    setConfirmDeleteOpen(false)
    setIsDeleting(true)
    setError(null)
    try {
      await window.electronAPI.agentRuntime.sendCommand({
        type: 'files:delete',
        fileIds: [file.fileId],
        userId,
      })
      if (sessionKey) {
        updateSessionState(sessionKey, (prev) => ({
          ...prev,
          fileEvents: prev.fileEvents.filter((f) => f.fileId !== file.fileId),
        }))
      }
      setPreviewing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    } finally {
      setIsDeleting(false)
    }
  }, [file.fileId, userId, sessionKey])

  return (
    <div className={styles.rowWrap}>
      <div
        className={clsx(
          styles.row,
          file.category === 'upload' && styles.rowUpload,
        )}
        title={file.localPath}
        draggable
        onDragStart={handleDragStart}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenuPos({ x: e.clientX, y: e.clientY })
        }}
      >
        <span className={styles.icon}>{icon}</span>
        <div className={styles.info}>
          <span className={styles.name}>{file.fileName}</span>
          <div className={styles.metaLine}>
            {file.category === 'upload' ? (
              <span className={clsx(styles.badge, styles.badgeUpload)}>上传</span>
            ) : (
              <span className={clsx(styles.badge, styles.badgeOutput)}>生成</span>
            )}
            {sizeText && <span className={styles.size}>{sizeText}</span>}
            {file.mimeType && <span className={styles.size}>{file.mimeType}</span>}
            {file.localPath && (
              <span className={styles.localPath} title={file.localPath}>{file.localPath}</span>
            )}
            {error && <span className={styles.error}>{error}</span>}
          </div>
        </div>
        <div className={styles.actions}>
          {canPreview && (
            <button
              className={styles.btn}
              onClick={() => setPreviewing((v) => !v)}
              title={previewing ? '收起预览' : '预览文件内容'}
            >
              {previewing ? '收起' : '预览'}
            </button>
          )}
          <button
            className={styles.btn}
            onClick={handleOpen}
            disabled={isOpening}
            title="用系统默认应用打开"
          >
            {isOpening ? '…' : '打开'}
          </button>
          <button
            className={clsx(styles.btn, styles.btnPrimary)}
            onClick={handleSaveAs}
            disabled={isSaving}
            title="下载到本地"
          >
            {isSaving ? '…' : '下载'}
          </button>
          {sessionKey ? (
            <button
              type="button"
              className={clsx(styles.btn, styles.btnDanger)}
              onClick={() => setConfirmDeleteOpen(true)}
              disabled={isDeleting}
              title="删除磁盘上的文件并移除记录"
            >
              {isDeleting ? '…' : '删除'}
            </button>
          ) : null}
        </div>
      </div>
      {previewing && canPreview && (
        <FilePreviewModal
          fileId={file.fileId}
          fileName={file.fileName}
          userId={userId}
          mdBasePath={file.localPath ?? undefined}
          editablePath={file.localPath ? toAbsolutePath(file.localPath) : undefined}
          onClose={() => setPreviewing(false)}
        />
      )}
      <ConfirmModal
        open={confirmDeleteOpen}
        title="删除文件"
        content={`确定删除「${file.fileName}」吗？将同时删除磁盘上的文件与数据库记录，且不可恢复。`}
        confirmText="删除"
        cancelText="取消"
        confirmVariant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
      {menuPos && createPortal(
        <div
          ref={menuRef}
          style={{
            position: 'fixed',
            left: Math.min(menuPos.x, window.innerWidth - 190),
            top: Math.min(menuPos.y, window.innerHeight - 120),
            zIndex: 600,
            minWidth: 168,
            padding: '4px',
            background: 'var(--color-bg-secondary)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--mt-radius-lg, 8px)',
            boxShadow: 'var(--mt-shadow-lg, 0 4px 16px rgba(0,0,0,0.2))',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {([
            { kind: 'name' as const, label: '复制文件名' },
            { kind: 'relative' as const, label: '复制相对路径' },
            { kind: 'absolute' as const, label: '复制绝对路径' },
          ]).map((opt) => (
            <button
              key={opt.kind}
              type="button"
              onClick={() => handleCopy(opt.kind)}
              style={{
                textAlign: 'left',
                padding: '7px 12px',
                border: 'none',
                background: 'transparent',
                color: 'var(--color-text-primary)',
                fontSize: 'var(--font-size-sm)',
                cursor: 'pointer',
                borderRadius: 'var(--radius-md, 6px)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-tertiary)' }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
            >
              {opt.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}

/** 对话流内单行：点击定位预览 + 更多操作（打开/下载/删除） */
const InlineFileRow: React.FC<{
  file: RuntimeFileEvent
  userId: string
  sessionKey: string | null
  onFileOpen?: (file: RuntimeFileEvent) => void
}> = ({ file, userId, sessionKey, onFileOpen }) => {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  const [busy, setBusy] = useState<'open' | 'save' | 'delete' | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const { toAbsolutePath } = useWorkspace()

  const badge = getExtBadge(file.fileName)
  const sizeText = formatSize(file.fileSize)
  const tag = file.category === 'upload' ? '上传' : '产出'

  useEffect(() => {
    if (!menuPos) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuPos(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuPos])

  /** 用系统默认应用打开 */
  const handleOpen = useCallback(async () => {
    setMenuPos(null)
    setBusy('open')
    try {
      await window.electronAPI.agentRuntime.sendCommand({
        type: 'files:open',
        fileId: file.fileId,
        userId,
      })
    } catch (err) {
      console.error('[SessionFileList] 打开失败:', err)
    } finally {
      setBusy(null)
    }
  }, [file.fileId, userId])

  /** 另存为 / 下载 */
  const handleSaveAs = useCallback(async () => {
    setMenuPos(null)
    setBusy('save')
    try {
      const result = await window.electronAPI.dialog?.showSaveDialog?.({
        defaultPath: file.fileName,
      })
      const savePath = result?.filePath
      if (savePath) {
        await window.electronAPI.agentRuntime.sendCommand({
          type: 'files:save-as',
          fileId: file.fileId,
          userId,
          savePath,
        })
      }
    } catch (err) {
      console.error('[SessionFileList] 下载失败:', err)
    } finally {
      setBusy(null)
    }
  }, [file.fileId, file.fileName, userId])

  /** 删除磁盘文件与记录 */
  const handleConfirmDelete = useCallback(async () => {
    setConfirmDeleteOpen(false)
    setBusy('delete')
    try {
      await window.electronAPI.agentRuntime.sendCommand({
        type: 'files:delete',
        fileIds: [file.fileId],
        userId,
      })
      if (sessionKey) {
        updateSessionState(sessionKey, (prev) => ({
          ...prev,
          fileEvents: prev.fileEvents.filter((f) => f.fileId !== file.fileId),
        }))
      }
    } catch (err) {
      console.error('[SessionFileList] 删除失败:', err)
    } finally {
      setBusy(null)
    }
  }, [file.fileId, userId, sessionKey])

  return (
    <div className={styles.inlineRowWrap}>
      <button
        type="button"
        className={styles.inlineRow}
        title={file.localPath || file.fileName}
        onClick={() => onFileOpen?.(file)}
      >
        <span
          className={clsx(styles.inlineBadge, styles[`inlineBadge--${badge.tone}`])}
          aria-hidden
        >
          {badge.label}
        </span>
        <span className={styles.inlineRowName}>{file.fileName}</span>
        <span className={styles.inlineRowMeta}>
          {sizeText && <span className={styles.inlineSize}>{sizeText}</span>}
          <span
            className={clsx(
              styles.inlineTag,
              file.category === 'upload' ? styles.inlineTagUpload : styles.inlineTagOutput,
            )}
          >
            {tag}
          </span>
        </span>
      </button>
      <button
        type="button"
        className={styles.inlineMoreBtn}
        title="更多操作"
        aria-label={`更多操作 ${file.fileName}`}
        disabled={busy !== null}
        onClick={(e) => {
          e.stopPropagation()
          const rect = e.currentTarget.getBoundingClientRect()
          setMenuPos({ x: rect.right - 160, y: rect.bottom + 4 })
        }}
      >
        ⋯
      </button>
      <ConfirmModal
        open={confirmDeleteOpen}
        title="删除文件"
        content={`确定删除「${file.fileName}」吗？将同时删除磁盘上的文件与数据库记录，且不可恢复。`}
        confirmText="删除"
        cancelText="取消"
        confirmVariant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => setConfirmDeleteOpen(false)}
      />
      {menuPos && createPortal(
        <div
          ref={menuRef}
          className={styles.inlineMoreMenu}
          style={{
            left: Math.min(menuPos.x, window.innerWidth - 180),
            top: Math.min(menuPos.y, window.innerHeight - 140),
          }}
        >
          <button type="button" className={styles.inlineMoreItem} onClick={handleOpen}>
            用其他应用打开
          </button>
          <button type="button" className={styles.inlineMoreItem} onClick={handleSaveAs}>
            下载文件
          </button>
          {sessionKey && (
            <button
              type="button"
              className={clsx(styles.inlineMoreItem, styles.inlineMoreItemDanger)}
              onClick={() => {
                setMenuPos(null)
                setConfirmDeleteOpen(true)
              }}
            >
              删除文件
            </button>
          )}
          <button
            type="button"
            className={styles.inlineMoreItem}
            onClick={() => {
              void navigator.clipboard.writeText(toAbsolutePath(file.localPath).replace(/\\/g, '/'))
              setMenuPos(null)
            }}
          >
            复制路径
          </button>
        </div>,
        document.body,
      )}
    </div>
  )
}

/**
 * 会话文件列表（可折叠卡片）
 *
 * - 列表为空时整个组件不渲染
 * - variant=inline：对话流内轻量 Files Changed 风格，支持展开/收起与「显示更多」
 */
export const SessionFileList: React.FC<SessionFileListProps> = ({
  files,
  userId = 'local-user',
  sessionKey,
  defaultExpanded = true,
  compact = false,
  variant = 'default',
  onReview,
  onFileOpen,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [showAll, setShowAll] = useState(false)

  /** 去重：相同 fileId 取最新一条；新文件在前 */
  const dedupedFiles = useMemo(() => {
    const map = new Map<string, RuntimeFileEvent>()
    for (const f of files) {
      map.set(f.fileId, f)
    }
    return Array.from(map.values()).reverse()
  }, [files])

  if (dedupedFiles.length === 0) return null

  const isInline = variant === 'inline' || variant === 'composer' || variant === 'rail'

  /** 对话流内：轻量 Files Changed 风格 */
  if (isInline) {
    const visibleFiles = showAll
      ? dedupedFiles
      : dedupedFiles.slice(0, COMPOSER_VISIBLE_COUNT)
    const hiddenCount = Math.max(0, dedupedFiles.length - COMPOSER_VISIBLE_COUNT)

    return (
      <div className={styles.inlineCard}>
        <div className={styles.inlineHeader}>
          <button
            type="button"
            className={styles.inlineHeaderToggle}
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            title={expanded ? '收起文件列表' : '展开文件列表'}
          >
            <span className={clsx(styles.inlineChevron, expanded && styles.inlineChevronOpen)}>
              ▾
            </span>
            <span className={styles.inlineHeaderTitle}>
              {dedupedFiles.length} 个文件变更
            </span>
          </button>
          {onReview && dedupedFiles[0] && (
            <button
              type="button"
              className={styles.inlineReview}
              onClick={() => onReview(dedupedFiles[0]!)}
            >
              查看
            </button>
          )}
        </div>

        {expanded && (
          <>
            <div className={styles.inlineList}>
              {visibleFiles.map((file) => (
                <InlineFileRow
                  key={file.fileId}
                  file={file}
                  userId={userId}
                  sessionKey={sessionKey}
                  onFileOpen={onFileOpen}
                />
              ))}
            </div>
            {!showAll && hiddenCount > 0 && (
              <button
                type="button"
                className={styles.inlineShowMore}
                onClick={() => setShowAll(true)}
              >
                … 显示另外 {hiddenCount} 个
              </button>
            )}
            {showAll && hiddenCount > 0 && (
              <button
                type="button"
                className={styles.inlineShowMore}
                onClick={() => setShowAll(false)}
              >
                收起
              </button>
            )}
          </>
        )}
      </div>
    )
  }

  /** 紧凑模式：小图标触发器 + 悬停弹出层 */
  if (compact) {
    return (
      <div className={styles.compactWrap}>
        <button
          type="button"
          className={styles.compactTrigger}
          aria-label={`会话文件 ${dedupedFiles.length} 个`}
          title={`会话文件（${dedupedFiles.length}）`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span className={styles.compactBadge}>{dedupedFiles.length}</span>
        </button>
        <div className={styles.compactPopover} role="region" aria-label="会话文件列表">
          <div className={styles.compactPopoverInner}>
            <div className={styles.compactPopoverHeader}>会话文件</div>
            <div className={styles.list}>
              {dedupedFiles.map((file) => (
                <FileRow key={file.fileId} file={file} userId={userId} sessionKey={sessionKey} />
              ))}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? '收起文件列表' : '展开文件列表'}
      >
        <span className={styles.headerIcon}>{expanded ? '▾' : '▸'}</span>
        <span className={styles.headerTitle}>会话文件</span>
        <span className={styles.headerCount}>{dedupedFiles.length}</span>
      </button>

      {expanded && (
        <div className={styles.list}>
          {dedupedFiles.map((file) => (
            <FileRow key={file.fileId} file={file} userId={userId} sessionKey={sessionKey} />
          ))}
        </div>
      )}
    </div>
  )
}

export default SessionFileList
