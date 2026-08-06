/**
 * WorkspaceFilePanel — 对话页面右侧工作空间文件抽屉
 *
 * - 右侧滑入 overlay 抽屉，不压缩聊天区域
 * - 树形目录（FileTree），懒加载，展示全部文件
 * - 点击文件 → 复用 FilePreviewModal 居中浮层预览
 * - 右键菜单 / 悬停按钮：预览、重命名、删除
 * - 所有颜色使用 CSS 变量，自动跟随深色/浅色主题
 */

import React, { useState, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { useWorkspace } from '../../../../hooks/business/useWorkspace'
import { useFiles } from '../../../../hooks/business/useFiles'
import { useCodingDevProjects } from '../../../../hooks/business/useCodingDevProjects'
import type { FileItem } from '../../../../hooks/business/useFiles/useFiles.types'
import { FilePreviewModal } from '../../../../components/FilePreviewModal'
import { ConfirmModal } from '../../../../components/ui/Modal/ConfirmModal'
import { FileTree } from './FileTree'
import { FileSearchBar } from './FileSearchBar'
import { ProjectsSection } from './ProjectsSection'
import styles from './WorkspaceFilePanel.module.css'

// ── SVG 图标 ──────────────────────────────────────────────────────────────

const IconX: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
)

const IconRefresh: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10" />
    <polyline points="1 20 1 14 7 14" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </svg>
)

const IconEye: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

const IconEdit: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
)

const IconTrash: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6" />
    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
  </svg>
)

const IconExternalLink: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </svg>
)

const IconFolder: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
)

const IconCopy: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
)

// ── 重命名对话框（内联，避免额外文件） ───────────────────────────────────

const RenameDialog: React.FC<{
  open: boolean
  currentName: string
  onConfirm: (newName: string) => void
  onCancel: () => void
}> = ({ open, currentName, onConfirm, onCancel }) => {
  const [value, setValue] = useState(currentName)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setValue(currentName)
      setTimeout(() => inputRef.current?.select(), 50)
    }
  }, [open, currentName])

  if (!open) return null

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && value.trim() && value.trim() !== currentName) {
      onConfirm(value.trim())
    } else if (e.key === 'Escape') {
      onCancel()
    }
  }

  return createPortal(
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 500,
        background: 'var(--mt-bg-modal-overlay)',
        backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: 'var(--color-bg-secondary)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--mt-radius-xl)',
          boxShadow: 'var(--mt-shadow-xl)',
          padding: '20px 24px',
          width: 320,
          display: 'flex', flexDirection: 'column', gap: 16,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontWeight: 600, fontSize: 'var(--font-size-base)', color: 'var(--color-text-primary)' }}>
          重命名
        </div>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          style={{
            width: '100%', padding: '8px 12px',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--color-bg-tertiary)',
            color: 'var(--color-text-primary)',
            fontSize: 'var(--font-size-sm)',
            outline: 'none',
            boxSizing: 'border-box',
          }}
          autoFocus
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            onClick={onCancel}
            style={{
              padding: '6px 16px', border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-md)', background: 'transparent',
              color: 'var(--color-text-secondary)', cursor: 'pointer',
              fontSize: 'var(--font-size-sm)',
            }}
          >
            取消
          </button>
          <button
            onClick={() => { if (value.trim() && value.trim() !== currentName) onConfirm(value.trim()) }}
            disabled={!value.trim() || value.trim() === currentName}
            style={{
              padding: '6px 16px', border: 'none',
              borderRadius: 'var(--radius-md)',
              background: 'var(--color-primary)',
              color: '#fff', cursor: 'pointer',
              fontSize: 'var(--font-size-sm)',
              opacity: (!value.trim() || value.trim() === currentName) ? 0.5 : 1,
            }}
          >
            确定
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// ── 右键菜单 ──────────────────────────────────────────────────────────────

interface ContextMenuState {
  x: number
  y: number
  item: FileItem
}

const ContextMenu: React.FC<{
  state: ContextMenuState
  onClose: () => void
  onPreview: (item: FileItem) => void
  onRename: (item: FileItem) => void
  onDelete: (item: FileItem) => void
  onOpenExternal: (item: FileItem) => void
  onCopy: (item: FileItem, kind: 'name' | 'relative' | 'absolute') => void
}> = ({ state, onClose, onPreview, onRename, onDelete, onOpenExternal, onCopy }) => {
  const menuRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  // 防止菜单超出视口
  const style: React.CSSProperties = { left: state.x, top: state.y }
  if (state.x + 180 > window.innerWidth) style.left = state.x - 180
  if (state.y + 280 > window.innerHeight) style.top = Math.max(8, state.y - 240)

  const isFile = !state.item.isDirectory
  const previewable = isFile && [
    // 文档
    'md', 'txt', 'log', 'csv', 'xml', 'pdf', 'docx',
    // 代码
    'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'json5',
    'py', 'sh', 'bash', 'java', 'kt', 'go', 'rs', 'cpp', 'c', 'h', 'cs', 'rb', 'php',
    'swift', 'dart', 'lua', 'r', 'scala', 'yaml', 'yml', 'toml', 'ini', 'env', 'sql',
    'graphql', 'gql', 'vue', 'svelte', 'html', 'htm', 'css',
    // 图片
    'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif',
    // 音频
    'mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'opus',
    // 视频
    'mp4', 'webm', 'mov', 'avi', 'm4v', 'ogv',
  ].includes(state.item.extension ?? '')

  return createPortal(
    <div ref={menuRef} className={styles.contextMenu} style={style}>
      {previewable && (
        <button className={styles.contextMenuItem} onClick={() => { onPreview(state.item); onClose() }}>
          <span className={styles.contextMenuIcon}><IconEye size={13} /></span>
          预览
        </button>
      )}
      <button className={styles.contextMenuItem} onClick={() => { onRename(state.item); onClose() }}>
        <span className={styles.contextMenuIcon}><IconEdit size={13} /></span>
        重命名
      </button>
      <button className={styles.contextMenuItem} onClick={() => { onOpenExternal(state.item); onClose() }}>
        <span className={styles.contextMenuIcon}><IconExternalLink size={13} /></span>
        在资源管理器中显示
      </button>
      <div className={styles.contextMenuDivider} />
      <button className={styles.contextMenuItem} onClick={() => { onCopy(state.item, 'name'); onClose() }}>
        <span className={styles.contextMenuIcon}><IconCopy size={13} /></span>
        复制文件名
      </button>
      <button className={styles.contextMenuItem} onClick={() => { onCopy(state.item, 'relative'); onClose() }}>
        <span className={styles.contextMenuIcon}><IconCopy size={13} /></span>
        复制相对路径
      </button>
      <button className={styles.contextMenuItem} onClick={() => { onCopy(state.item, 'absolute'); onClose() }}>
        <span className={styles.contextMenuIcon}><IconCopy size={13} /></span>
        复制绝对路径
      </button>
      <div className={styles.contextMenuDivider} />
      <button className={clsx(styles.contextMenuItem, styles['contextMenuItem--danger'])} onClick={() => { onDelete(state.item); onClose() }}>
        <span className={styles.contextMenuIcon}><IconTrash size={13} /></span>
        删除
      </button>
    </div>,
    document.body,
  )
}

// ── WorkspaceFilePanel ────────────────────────────────────────────────────

export interface WorkspaceFilePanelProps {
  open: boolean
  onClose: () => void
  /** 外部请求定位到指定绝对路径的文件（点击输入框 @引用 chip 触发） */
  locateTarget?: { path: string; token: number } | null
  /** 嵌入 WorkspaceWorkbench 时去掉独立抽屉壳与关闭钮 */
  embedded?: boolean
}

export const WorkspaceFilePanel: React.FC<WorkspaceFilePanelProps> = ({
  open,
  onClose,
  locateTarget,
  embedded = false,
}) => {
  const { workspaceDir, isInitializing } = useWorkspace()
  const { renameFile } = useFiles(
    workspaceDir ? { initialPath: workspaceDir, rootPath: workspaceDir, watchIntervalMs: 0 } : undefined
  )
  const projectsApi = useCodingDevProjects()

  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  /** 外部定位请求的目标路径（驱动 FileTree 展开并滚动到该节点） */
  const [revealPath, setRevealPath] = useState<string | null>(null)
  /** 驱动 FileTree 重新执行定位（侧栏项目点击与外部 locateTarget 共用） */
  const [revealToken, setRevealToken] = useState(0)
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [renameTarget, setRenameTarget] = useState<FileItem | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<FileItem | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [isRefreshing, setIsRefreshing] = useState(false)
  /** 搜索模式下隐藏树形视图，只显示搜索结果（由 FileSearchBar 内部渲染） */
  const [isSearching, setIsSearching] = useState(false)

  // 搜索结果点击：非目录直接预览；目录暂不做跳转（树状视图已展开显示）
  const handleSearchSelect = useCallback((item: FileItem) => {
    setSelectedPath(item.path)
    if (!item.isDirectory) setPreviewFile(item)
  }, [])

  // Escape 关闭抽屉（嵌入壳时由 WorkspaceWorkbench 统一处理 Esc）
  useEffect(() => {
    if (!open || embedded) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !previewFile && !renameTarget && !deleteTarget && !contextMenu) {
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, embedded, onClose, previewFile, renameTarget, deleteTarget, contextMenu])

  // 面板每次重新打开时刷新文件列表与项目列表
  useEffect(() => {
    if (open && workspaceDir) {
      setRefreshToken((t) => t + 1)
      void projectsApi.reload()
    }
  }, [open, workspaceDir]) // eslint-disable-line react-hooks/exhaustive-deps -- 仅在打开/工作区变更时刷新

  const handleSelect = useCallback((item: FileItem) => {
    setSelectedPath(item.path)
    if (!item.isDirectory) setPreviewFile(item)
  }, [])

  // 外部定位请求：选中并触发树形展开/滚动（token 变化即重复定位）
  useEffect(() => {
    if (!locateTarget?.path) return
    setSelectedPath(locateTarget.path)
    setRevealPath(locateTarget.path)
    setRevealToken(locateTarget.token)
  }, [locateTarget?.token, locateTarget?.path])

  /**
   * 构造 workspace/projects/<name> 绝对路径并定位文件树。
   */
  const locateProjectInTree = useCallback((name: string) => {
    if (!workspaceDir) return
    const sep = workspaceDir.includes('\\') ? '\\' : '/'
    const root = workspaceDir.replace(/[\\/]+$/, '')
    const projectPath = `${root}${sep}projects${sep}${name}`
    setSelectedPath(projectPath)
    setRevealPath(projectPath)
    setRevealToken((t) => t + 1)
  }, [workspaceDir])

  /** 项目增删后刷新文件树 */
  const handleTreeRefresh = useCallback(() => {
    setRefreshToken((t) => t + 1)
  }, [])

  const handleContextMenu = useCallback((e: React.MouseEvent, item: FileItem) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, item })
  }, [])

  const handleMoreClick = useCallback((e: React.MouseEvent, item: FileItem) => {
    e.preventDefault()
    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setContextMenu({ x: rect.left, y: rect.bottom + 4, item })
  }, [])

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true)
    setRefreshToken((t) => t + 1)
    setTimeout(() => setIsRefreshing(false), 600)
  }, [])

  const handleRename = useCallback(async (newName: string) => {
    if (!renameTarget) return
    try {
      await renameFile(renameTarget.path, newName)
      setRefreshToken((t) => t + 1)
    } catch (err) {
      console.error('[WorkspaceFilePanel] 重命名失败:', err)
    } finally {
      setRenameTarget(null)
    }
  }, [renameTarget, renameFile])

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await window.electronAPI.file.delete(deleteTarget.path)
      if (selectedPath === deleteTarget.path) setSelectedPath(null)
      setRefreshToken((t) => t + 1)
    } catch (err) {
      console.error('[WorkspaceFilePanel] 删除失败:', err)
    } finally {
      setDeleteTarget(null)
    }
  }, [deleteTarget, selectedPath])

  const handleOpenExternal = useCallback((item: FileItem) => {
    window.electronAPI.app.showItemInFolder(item.path)
  }, [])

  const handleCopy = useCallback((item: FileItem, kind: 'name' | 'relative' | 'absolute') => {
    const absPath = item.path.replace(/\\/g, '/')
    let text = absPath
    if (kind === 'name') {
      text = item.name
    } else if (kind === 'relative') {
      const root = (workspaceDir ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
      text = root && absPath.startsWith(root + '/')
        ? absPath.slice(root.length + 1)
        : absPath
    }
    void navigator.clipboard.writeText(text).catch((err) => {
      console.error('[WorkspaceFilePanel] 复制失败:', err)
    })
  }, [workspaceDir])

  if (!embedded && !open && !workspaceDir) return null
  if (embedded && !open) return null

  return (
    <>
      {/* 抽屉主体（embedded 时填满 Workbench body） */}
      <div
        className={clsx(
          styles.drawer,
          open && styles['drawer--open'],
          embedded && styles.drawerEmbedded,
        )}
        aria-label="工作空间文件"
      >

        {/* 独立模式才显示标题栏；嵌入时由壳层提供 tabs */}
        {!embedded && (
          <div className={styles.header}>
            <span className={styles.title}>工作空间文件</span>
            <button
              className={clsx(styles.headerBtn, isRefreshing && styles['headerBtn--spinning'])}
              onClick={handleRefresh}
              disabled={isRefreshing || isInitializing}
              title="刷新"
            >
              <IconRefresh size={14} />
            </button>
            <button className={styles.headerBtn} onClick={onClose} title="关闭">
              <IconX size={14} />
            </button>
          </div>
        )}
        {embedded && (
          <div className={styles.embeddedToolbar}>
            <button
              className={clsx(styles.headerBtn, isRefreshing && styles['headerBtn--spinning'])}
              onClick={handleRefresh}
              disabled={isRefreshing || isInitializing}
              title="刷新"
            >
              <IconRefresh size={14} />
            </button>
          </div>
        )}

        {/* ACP 项目列表（根仍为 workspaceDir，projects/ 在树中自动出现） */}
        {!isInitializing && workspaceDir && (
          <ProjectsSection
            api={projectsApi}
            onLocateProject={locateProjectInTree}
            onTreeRefresh={handleTreeRefresh}
          />
        )}

        {/* 搜索栏（workspaceDir 就绪后显示） */}
        {!isInitializing && workspaceDir && (
          <FileSearchBar
            rootPath={workspaceDir}
            onSelectResult={handleSearchSelect}
            onSearchStateChange={setIsSearching}
            onContextMenu={handleContextMenu}
          />
        )}

        {/* 树形目录区域（搜索态隐藏，避免与搜索结果争抢高度导致结果只展示一半） */}
        {!isSearching && (
          <div className={styles.treeArea}>
            {isInitializing && (
              <div className={styles.empty}>
                <span className={styles.emptyIcon}><IconFolder size={32} /></span>
                <span>初始化工作空间...</span>
              </div>
            )}
            {!isInitializing && !workspaceDir && (
              <div className={styles.empty}>
                <span className={styles.emptyIcon}><IconFolder size={32} /></span>
                <span>工作空间未就绪</span>
              </div>
            )}
            {!isInitializing && workspaceDir && (
              <FileTree
                rootPath={workspaceDir}
                selectedPath={selectedPath}
                revealPath={revealPath}
                revealToken={revealToken}
                onSelect={handleSelect}
                onContextMenu={handleContextMenu}
                onMoreClick={handleMoreClick}
                refreshToken={refreshToken}
              />
            )}
          </div>
        )}
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <ContextMenu
          state={contextMenu}
          onClose={() => setContextMenu(null)}
          onPreview={(item) => { setPreviewFile(item); setSelectedPath(item.path) }}
          onRename={(item) => setRenameTarget(item)}
          onDelete={(item) => setDeleteTarget(item)}
          onOpenExternal={handleOpenExternal}
          onCopy={handleCopy}
        />
      )}

      {/* 文件预览 Modal（复用现有组件，createPortal 挂到 body） */}
      {previewFile && (
        <FilePreviewModal
          filePath={previewFile.path}
          fileName={previewFile.name}
          onClose={() => setPreviewFile(null)}
        />
      )}

      {/* 重命名弹窗 */}
      <RenameDialog
        open={!!renameTarget}
        currentName={renameTarget?.name ?? ''}
        onConfirm={handleRename}
        onCancel={() => setRenameTarget(null)}
      />

      {/* 删除确认 */}
      <ConfirmModal
        open={!!deleteTarget}
        title="确认删除"
        content={`确定要删除「${deleteTarget?.name ?? ''}」吗？此操作不可恢复。`}
        confirmText="删除"
        cancelText="取消"
        confirmVariant="danger"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  )
}
