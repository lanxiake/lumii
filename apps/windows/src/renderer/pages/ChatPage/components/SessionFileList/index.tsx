/**
 * SessionFileList — 当前会话文件列表（可折叠）
 *
 * 职责：
 * - 汇总当前会话中 Agent 生成 / 通道接收的所有文件（来自 agent-runtime-store 的 fileEvents）
 * - 提供预览、打开、另存为（下载）、删除操作
 * - 可折叠，避免占用对话区域过多空间
 *
 * 使用：
 * - 放置在对话输出区（ChatContainer）上方 / 输入框上方
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

export interface SessionFileListProps {
  /** 当前会话的全部文件事件（来自 runtimeStore.fileEvents，按 conversationId 分组后传入） */
  files: readonly RuntimeFileEvent[]
  userId?: string
  /** 当前会话 key，删除成功后用于从 runtimeStore 移除对应 fileEvents */
  sessionKey: string | null
  /** 默认是否展开（仅非 compact 模式生效） */
  defaultExpanded?: boolean
  /** 紧凑模式：仅显示小图标，悬停时弹出完整列表 */
  compact?: boolean
}

/** 格式化文件大小（B / KB / MB） */
function formatSize(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 根据文件 MIME / 扩展名返回图标 emoji */
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
  }
  const ext = name.includes('.') ? (name.split('.').pop() ?? '') : ''
  return ['txt', 'md', 'json', 'pdf', 'doc', 'docx', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'htm', 'html', 'css', 'js', 'ts', 'tsx', 'jsx'].includes(ext)
}

/** 单个文件行 */
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

  // 右键菜单：点击外部关闭
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

  /**
   * 软删除数据库记录并从当前会话的 fileEvents 中移除（不阻塞侧栏其他逻辑）
   */
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

/**
 * 会话文件列表（可折叠卡片）
 *
 * - 列表为空时整个组件不渲染
 * - 默认展开，顶部有折叠/展开按钮
 */
export const SessionFileList: React.FC<SessionFileListProps> = ({
  files,
  userId = 'local-user',
  sessionKey,
  defaultExpanded = false,
  compact = false,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded)

  /** 去重：相同 fileId 取最新一条；按生成时间（这里近似为列表顺序）倒序展示（新 → 旧） */
  const dedupedFiles = useMemo(() => {
    const map = new Map<string, RuntimeFileEvent>()
    for (const f of files) {
      map.set(f.fileId, f)
    }
    // 保留原始顺序，最新的在末尾；这里反转为"新文件在前"
    return Array.from(map.values()).reverse()
  }, [files])

  if (dedupedFiles.length === 0) return null

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
