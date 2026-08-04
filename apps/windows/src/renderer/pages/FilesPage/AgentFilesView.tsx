/**
 * AgentFilesView — AI 生成文件列表视图
 *
 * 展示 client_files 表中 Agent 输出的文件，
 * 支持搜索、过滤（通道/分类）、预览、另存为、批量删除。
 */

import React, { useState, useCallback, useMemo } from 'react'
import clsx from 'clsx'
import { useAgentFiles } from '../../hooks/business/useAgentFiles'
import type { AgentFile, AgentFilesFilter } from '../../hooks/business/useAgentFiles'
import { FilePreviewModal } from '../../components/FilePreviewModal'
import { ConfirmModal } from '../../components/ui/Modal/ConfirmModal'
import { Button } from '../../components/ui/Button/Button'
import { Input } from '../../components/ui/Input/Input'
import styles from './AgentFilesView.module.css'

// ── 文件图标 ──
function getFileIcon(mimeType: string | null, fileName: string): string {
  if (!mimeType) {
    const ext = fileName.split('.').pop()?.toLowerCase()
    const map: Record<string, string> = { pdf: '📕', zip: '📦', tar: '📦', mp4: '🎬', mp3: '🎵' }
    return map[ext ?? ''] ?? '📎'
  }
  if (mimeType.startsWith('image/')) return '🖼️'
  if (mimeType === 'application/pdf') return '📕'
  if (mimeType.startsWith('text/')) return '📄'
  if (mimeType === 'application/json') return '📋'
  if (mimeType.includes('zip') || mimeType.includes('tar')) return '📦'
  if (mimeType.startsWith('video/')) return '🎬'
  if (mimeType.startsWith('audio/')) return '🎵'
  return '📎'
}

function formatSize(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return iso
  }
}

// ── 过滤器面板 ──
interface FilterPanelProps {
  filter: AgentFilesFilter
  onChange: (f: AgentFilesFilter) => void
}
const FilterPanel: React.FC<FilterPanelProps> = ({ filter, onChange }) => (
  <div className={styles['filter-panel']}>
    <label className={styles['filter-label']}>
      通道
      <select
        className={styles['filter-select']}
        value={filter.channel ?? ''}
        onChange={(e) => onChange({ ...filter, channel: e.target.value || undefined })}
      >
        <option value="">全部</option>
        <option value="windows">Windows</option>
        <option value="wechat">微信</option>
      </select>
    </label>
    <label className={styles['filter-label']}>
      分类
      <select
        className={styles['filter-select']}
        value={filter.category ?? ''}
        onChange={(e) => onChange({ ...filter, category: (e.target.value as 'upload' | 'output') || undefined })}
      >
        <option value="">全部</option>
        <option value="output">AI 生成</option>
        <option value="upload">用户上传</option>
      </select>
    </label>
  </div>
)

// ── 单行文件项 ──
interface FileRowProps {
  file: AgentFile
  selected: boolean
  onToggle: () => void
  onPreview: () => void
  onOpen: () => void
  onSaveAs: () => void
}
const FileRow: React.FC<FileRowProps> = ({ file, selected, onToggle, onPreview, onOpen, onSaveAs }) => {
  const icon = getFileIcon(file.mimeType, file.fileName)
  const isPreviewable = file.mimeType
    ? (file.mimeType.startsWith('text/') || file.mimeType.startsWith('image/') ||
      ['text/html', 'text/css', 'application/javascript', 'image/svg+xml'].includes(file.mimeType))
    : false

  return (
    <div className={clsx(styles['file-row'], selected && styles['selected'])}>
      <input
        type="checkbox"
        className={styles['row-check']}
        checked={selected}
        onChange={onToggle}
      />
      <span className={styles['row-icon']}>{icon}</span>
      <div className={styles['row-info']}>
        <span className={styles['row-name']} title={file.fileName}>{file.fileName}</span>
        <span className={styles['row-meta']}>
          {formatSize(file.fileSize)}
          {' · '}
          {file.channel}
          {file.category === 'output' ? ' · AI生成' : ' · 上传'}
          {' · '}
          {formatDate(file.createdAt)}
        </span>
      </div>
      <div className={styles['row-actions']}>
        {isPreviewable && (
          <button className={styles['row-btn']} onClick={onPreview} title="预览">预览</button>
        )}
        <button className={styles['row-btn']} onClick={onOpen} title="打开">打开</button>
        <button className={styles['row-btn']} onClick={onSaveAs} title="另存为">另存</button>
      </div>
    </div>
  )
}

// ── 主组件 ──
interface AgentFilesViewProps {
  userId: string
}

export const AgentFilesView: React.FC<AgentFilesViewProps> = ({ userId }) => {
  const {
    files,
    total,
    loading,
    error,
    hasMore,
    searchQuery,
    filter,
    setSearchQuery,
    setFilter,
    loadMore,
    refresh,
    deleteFiles,
  } = useAgentFiles(userId)

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [previewFile, setPreviewFile] = useState<{ id: string; name: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(files.map((f) => f.id)))
  }, [files])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
  }, [])

  const handleOpen = useCallback(async (file: AgentFile) => {
    setOpenError(null)
    try {
      await window.electronAPI.agentRuntime.sendCommand({
        type: 'files:open',
        fileId: file.id,
        userId,
      })
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : '打开失败')
    }
  }, [userId])

  const handleSaveAs = useCallback(async (file: AgentFile) => {
    try {
      const result = await window.electronAPI.dialog?.showSaveDialog?.({ defaultPath: file.fileName })
      const savePath = result?.filePath
      if (savePath) {
        await window.electronAPI.agentRuntime.sendCommand({
          type: 'files:save-as',
          fileId: file.id,
          userId,
          savePath,
        })
      }
    } catch (err) {
      setOpenError(err instanceof Error ? err.message : '另存为失败')
    }
  }, [userId])

  const handleBatchDelete = useCallback(async () => {
    const ids = Array.from(selectedIds)
    setConfirmDelete(false)
    clearSelection()
    await deleteFiles(ids)
  }, [selectedIds, deleteFiles, clearSelection])

  const allSelected = useMemo(() =>
    files.length > 0 && files.every((f) => selectedIds.has(f.id)),
    [files, selectedIds]
  )

  return (
    <div className={styles['agent-files-view']}>
      {/* 工具栏 */}
      <div className={styles['toolbar']}>
        <Input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="搜索文件名…"
          className={styles['search-input']}
        />
        <Button variant="ghost" size="sm" onClick={refresh} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </Button>
        {selectedIds.size > 0 && (
          <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
            删除 {selectedIds.size} 项
          </Button>
        )}
      </div>

      {/* 过滤器 */}
      <FilterPanel filter={filter} onChange={setFilter} />

      {/* 错误提示 */}
      {(error || openError) && (
        <div className={styles['error-bar']}>
          ⚠ {error ?? openError}
        </div>
      )}

      {/* 列表头 */}
      <div className={styles['list-header']}>
        <input
          type="checkbox"
          checked={allSelected}
          onChange={() => allSelected ? clearSelection() : selectAll()}
          title="全选"
        />
        <span>文件名</span>
        <span className={styles['header-right']}>共 {total} 个文件</span>
      </div>

      {/* 文件列表 */}
      <div className={styles['file-list']}>
        {loading && files.length === 0 ? (
          <div className={styles['placeholder']}>加载中…</div>
        ) : files.length === 0 ? (
          <div className={styles['placeholder']}>
            {searchQuery ? '未找到匹配的文件' : 'Agent 尚未生成任何文件'}
          </div>
        ) : (
          <>
            {files.map((file) => (
              <FileRow
                key={file.id}
                file={file}
                selected={selectedIds.has(file.id)}
                onToggle={() => toggleSelect(file.id)}
                onPreview={() => setPreviewFile({ id: file.id, name: file.fileName })}
                onOpen={() => void handleOpen(file)}
                onSaveAs={() => void handleSaveAs(file)}
              />
            ))}
            {hasMore && (
              <div className={styles['load-more']}>
                <Button variant="ghost" size="sm" onClick={loadMore} disabled={loading}>
                  {loading ? '加载中…' : '加载更多'}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* 预览 Modal */}
      {previewFile && (
        <FilePreviewModal
          fileId={previewFile.id}
          fileName={previewFile.name}
          userId={userId}
          onClose={() => setPreviewFile(null)}
        />
      )}

      {/* 批量删除确认 */}
      <ConfirmModal
        open={confirmDelete}
        title="确认删除"
        content={`确定要删除选中的 ${selectedIds.size} 个文件吗？此操作不可恢复。`}
        confirmText="删除"
        cancelText="取消"
        confirmVariant="danger"
        onConfirm={() => void handleBatchDelete()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  )
}
