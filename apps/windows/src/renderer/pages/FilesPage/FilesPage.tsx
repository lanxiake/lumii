/**
 * FilesPage - 工作空间文件浏览器
 *
 * 基于原项目 FilesView.tsx 重构
 * 以工作空间目录为根的文件浏览器，支持导航、搜索、文件操作
 * 不展示配置文件（如 SOUL.md 等配置文件）和 .lumii 内部目录
 */

import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import MDEditor from '@uiw/react-md-editor'
import { useWorkspace } from '../../hooks/business/useWorkspace'
import { useFiles, formatFileSize } from '../../hooks/business/useFiles'
import type { FileItem } from '../../hooks/business/useFiles/useFiles.types'
import { AgentFilesView } from './AgentFilesView'
import { ErrorBanner } from '../../components/ui/ErrorBanner/ErrorBanner'
import { Loading } from '../../components/ui/Loading/Loading'
import { Button } from '../../components/ui/Button/Button'
import { Input } from '../../components/ui/Input/Input'
import { Modal } from '../../components/ui/Modal/Modal'
import { ConfirmModal } from '../../components/ui/Modal/ConfirmModal'
import { Empty } from '../../components/ui/Empty/Empty'
import { useToast } from '../../components/ui/Toast/useToast'
import { useDataThemeColorMode } from '../../hooks/common/useDataThemeColorMode'
import clsx from 'clsx'
import styles from './FilesPage.module.css'

const VIRTUAL_LIST_THRESHOLD = 1000
const VIRTUAL_ROW_HEIGHT = 68
const VIRTUAL_OVERSCAN = 8

/**
 * 文件页快捷入口定义（用户视角）。
 */
type UserQuickLocation = {
  id: 'all' | 'uploads' | 'outputs' | 'myfiles'
  label: string
  icon: string
  relativePath: string
}

/**
 * 用户可见的快捷位置，隐藏技术路径细节。
 */
const USER_QUICK_LOCATIONS: UserQuickLocation[] = [
  { id: 'all', label: '全部文件', icon: '🏠', relativePath: '' },
  { id: 'uploads', label: '我上传的', icon: '📥', relativePath: 'uploads' },
  { id: 'outputs', label: 'AI生成的', icon: '📤', relativePath: 'outputs' },
  { id: 'myfiles', label: '我的文件', icon: '📁', relativePath: 'files' },
]

/**
 * 工作空间根目录下需要隐藏的条目（Gateway 配置文件和内部目录）
 */
const WORKSPACE_HIDDEN_AT_ROOT = new Set([
  'SOUL.md',
  'IDENTITY.md',
  'AGENTS.md',
  'TOOLS.md',
  'HEARTBEAT.md',
  'BOOTSTRAP.md',
  '.lumii',
])

/**
 * 格式化日期
 */
function formatDate(date: Date): string {
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * 生成当前路径的面包屑片段。
 */
function buildBreadcrumbSegments(relativePath: string): string[] {
  const normalized = relativePath === '/' ? '' : relativePath
  return normalized.split('/').map((segment) => segment.trim()).filter(Boolean)
}

/**
 * 文件列表项组件
 */
const FileListItem: React.FC<{
  file: FileItem
  isSelected: boolean
  onSelect: (e: React.MouseEvent) => void
  onDoubleClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
  onDragStart?: (e: React.DragEvent) => void
  onDragOver?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
  onDragLeave?: (e: React.DragEvent) => void
  isDragOver?: boolean
}> = ({ file, isSelected, onSelect, onDoubleClick, onContextMenu, onDragStart, onDragOver, onDrop, onDragLeave, isDragOver }) => {
  return (
    <div
      className={clsx(styles['file-item'], isSelected && styles['selected'], file.isDirectory && styles['directory'], isDragOver && styles['drag-over'])}
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      draggable
      onDragStart={onDragStart}
      onDragOver={file.isDirectory ? onDragOver : undefined}
      onDrop={file.isDirectory ? onDrop : undefined}
      onDragLeave={file.isDirectory ? onDragLeave : undefined}
    >
      <div className={styles['file-icon']}>{file.icon}</div>
      <div className={styles['file-info']}>
        <span className={styles['file-name']}>{file.name}</span>
        <div className={styles['file-meta']}>
          {!file.isDirectory && <span className={styles['file-size']}>{formatFileSize(file.size)}</span>}
          <span className={styles['file-date']}>{formatDate(file.modifiedAt)}</span>
        </div>
      </div>
    </div>
  )
}

/**
 * 新建文件夹对话框
 */
const NewFolderDialog: React.FC<{
  open: boolean
  onConfirm: (name: string) => void
  onCancel: () => void
}> = ({ open, onConfirm, onCancel }) => {
  const [folderName, setFolderName] = useState('')

  const handleConfirm = () => {
    if (folderName.trim()) {
      onConfirm(folderName.trim())
      setFolderName('')
    }
  }

  return (
    <Modal
      open={open}
      title="新建文件夹"
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button onClick={handleConfirm} disabled={!folderName.trim()}>
            创建
          </Button>
        </>
      }
    >
      <Input
        type="text"
        value={folderName}
        onChange={(e) => setFolderName(e.target.value)}
        placeholder="文件夹名称"
        autoFocus
      />
    </Modal>
  )
}

/**
 * 重命名对话框
 */
const RenameDialog: React.FC<{
  open: boolean
  currentName: string
  onConfirm: (newName: string) => void
  onCancel: () => void
}> = ({ open, currentName, onConfirm, onCancel }) => {
  const [newName, setNewName] = useState(currentName)

  const handleConfirm = () => {
    if (newName.trim() && newName !== currentName) {
      onConfirm(newName.trim())
    }
  }

  React.useEffect(() => {
    if (open) {
      setNewName(currentName)
    }
  }, [open, currentName])

  return (
    <Modal
      open={open}
      title="重命名"
      onClose={onCancel}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!newName.trim() || newName === currentName}
          >
            确定
          </Button>
        </>
      }
    >
      <Input
        type="text"
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        placeholder="新名称"
        autoFocus
      />
    </Modal>
  )
}

/**
 * 工作空间文件浏览器
 */
export const FilesPage: React.FC = () => {
  const { error: showError } = useToast()
  const mdColorMode = useDataThemeColorMode()

  /** 当前视图模式：'workspace' = 工作空间文件系统，'agent' = AI 生成文件（DB） */
  const [viewMode, setViewMode] = useState<'workspace' | 'agent'>('workspace')

  // 工作空间管理
  const {
    workspaceDir,
    isInitializing,
    initError,
    toRelativePath,
    toAbsolutePath,
  } = useWorkspace()

  // 文件管理，以工作空间为根
  const {
    currentPath,
    files: rawFiles,
    isLoading,
    error,
    selectedFiles,
    sortBy,
    sortOrder,
    historyIndex,
    history,
    navigateTo,
    refresh,
    goUp,
    goBack,
    goForward,
    toggleSelect,
    selectAll,
    clearSelection,
    setSorting,
    createFolder,
    deleteSelected,
    renameFile,
    readFile,
    copyFile,
    moveFile,
    openInExplorer,
    copyPathToClipboard,
  } = useFiles(
    workspaceDir
      ? { initialPath: workspaceDir, rootPath: workspaceDir, watchIntervalMs: 2000 }
      : undefined
  )

  /**
   * 过滤文件列表：在工作空间根目录时隐藏配置文件和 .lumii 目录
   */
  const files = useMemo(() => {
    if (!workspaceDir) {
      return rawFiles
    }
    const isAtRoot =
      currentPath.replace(/\\/g, '/') === workspaceDir.replace(/\\/g, '/')
    if (!isAtRoot) {
      return rawFiles
    }
    return rawFiles.filter((f) => !WORKSPACE_HIDDEN_AT_ROOT.has(f.name))
  }, [rawFiles, currentPath, workspaceDir])

  const [showNewFolderDialog, setShowNewFolderDialog] = useState(false)
  const [renameTarget, setRenameTarget] = useState<FileItem | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    file: FileItem | null
  } | null>(null)
  const [isDeleteFilesModalOpen, setIsDeleteFilesModalOpen] = useState(false)
  const [filesToDeleteCount, setFilesToDeleteCount] = useState(0)
  const [isDropActive, setIsDropActive] = useState(false)
  const [previewContent, setPreviewContent] = useState<string | null>(null)
  const [isPreviewLoading, setIsPreviewLoading] = useState(false)
  const [isEditingPreview, setIsEditingPreview] = useState(false)
  const [editingContent, setEditingContent] = useState<string>('')
  const [isSavingPreview, setIsSavingPreview] = useState(false)
  const [pendingTransfer, setPendingTransfer] = useState<{
    mode: 'copy' | 'cut'
    sourcePaths: string[]
  } | null>(null)
  const [dragOverFolderPath, setDragOverFolderPath] = useState<string | null>(null)
  const [listScrollTop, setListScrollTop] = useState(0)
  const [listViewportHeight, setListViewportHeight] = useState(420)
  const listRef = useRef<HTMLDivElement | null>(null)

  /**
   * 当前用于预览的文件（仅支持文本类文件）。
   */
  const previewTarget = useMemo(() => {
    if (selectedFiles.size !== 1) {
      return null
    }
    const filePath = Array.from(selectedFiles)[0]
    const file = files.find((item) => item.path === filePath)
    if (!file || file.isDirectory) {
      return null
    }
    if (!file.extension || !['txt', 'md', 'json', 'log'].includes(file.extension)) {
      return null
    }
    return file
  }, [files, selectedFiles])
  const previewTargetPath = previewTarget?.path ?? null
  const previewTargetModifiedAt = previewTarget?.modifiedAt.getTime() ?? 0

  /**
   * 计算虚拟滚动窗口的起止索引。
   */
  const virtualRange = useMemo(() => {
    if (files.length <= VIRTUAL_LIST_THRESHOLD) {
      return null
    }
    const start = Math.max(0, Math.floor(listScrollTop / VIRTUAL_ROW_HEIGHT) - VIRTUAL_OVERSCAN)
    const visibleCount = Math.ceil(listViewportHeight / VIRTUAL_ROW_HEIGHT) + VIRTUAL_OVERSCAN * 2
    const end = Math.min(files.length, start + visibleCount)
    return { start, end }
  }, [files.length, listScrollTop, listViewportHeight])

  /**
   * 当工作空间目录初始化完成后，导航到工作空间根目录
   * 使用 ref 追踪是否已经初始化过，避免重复导航
   */
  const hasInitializedRef = useRef(false)

  useEffect(() => {
    if (workspaceDir && !isInitializing && !hasInitializedRef.current) {
      console.log('[FilesPage] 工作空间已初始化，导航到:', workspaceDir)
      hasInitializedRef.current = true
      navigateTo(workspaceDir)
    }
  }, [workspaceDir, isInitializing, navigateTo])

  /**
   * 处理文件单击选中：
   * - 普通点击 = 单选（替换之前选中）
   * - Ctrl/Cmd + 点击 = 多选 toggle
   */
  const handleFileClick = useCallback(
    (e: React.MouseEvent, file: FileItem) => {
      if (e.ctrlKey || e.metaKey) {
        toggleSelect(file.path)
      } else {
        clearSelection()
        toggleSelect(file.path)
      }
    },
    [toggleSelect, clearSelection]
  )

  /**
   * 处理文件双击
   */
  const handleFileDoubleClick = useCallback(
    (file: FileItem) => {
      if (file.isDirectory) {
        navigateTo(file.path)
      } else {
        // 打开文件 (使用系统默认程序)
        console.log('[FilesPage] 打开文件:', file.path)
        window.electronAPI.app.openExternal(file.path)
      }
    },
    [navigateTo]
  )

  /**
   * 处理右键菜单（stopPropagation 防止冒泡到背景）
   */
  const handleContextMenu = useCallback(
    (e: React.MouseEvent, file: FileItem | null) => {
      e.preventDefault()
      e.stopPropagation()
      setContextMenu({ x: e.clientX, y: e.clientY, file })
    },
    []
  )

  /**
   * 关闭右键菜单
   */
  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  /**
   * 处理用户快捷位置点击并刷新列表。
   */
  const handleLocationClick = useCallback(
    async (location: UserQuickLocation) => {
      const targetPath = toAbsolutePath(location.relativePath)
      await navigateTo(targetPath)
      await refresh()
    },
    [toAbsolutePath, navigateTo, refresh]
  )

  /**
   * 处理面包屑导航点击。
   */
  const handleBreadcrumbNavigate = useCallback(
    async (index: number) => {
      const relativePath = toRelativePath(currentPath)
      const segments = buildBreadcrumbSegments(relativePath)
      if (index < 0) {
        await navigateTo(workspaceDir)
        await refresh()
        return
      }
      const targetRelative = segments.slice(0, index + 1).join('/')
      await navigateTo(toAbsolutePath(targetRelative))
      await refresh()
    },
    [currentPath, navigateTo, refresh, toAbsolutePath, toRelativePath, workspaceDir]
  )

  /**
   * 处理新建文件夹
   */
  const handleCreateFolder = useCallback(
    async (name: string) => {
      try {
        await createFolder(name)
        setShowNewFolderDialog(false)
      } catch (err) {
        showError(err instanceof Error ? err.message : '创建失败')
      }
    },
    [createFolder, showError]
  )

  /**
   * 处理删除 - 打开确认对话框
   */
  const handleDelete = useCallback(() => {
    if (selectedFiles.size === 0) {
      return
    }

    setFilesToDeleteCount(selectedFiles.size)
    setIsDeleteFilesModalOpen(true)
  }, [selectedFiles])

  /**
   * 确认删除文件
   */
  const handleConfirmDeleteFiles = useCallback(async () => {
    try {
      await deleteSelected()
    } catch (err) {
      showError(err instanceof Error ? err.message : '删除失败')
    } finally {
      setIsDeleteFilesModalOpen(false)
      setFilesToDeleteCount(0)
    }
  }, [deleteSelected, showError])

  /**
   * 取消删除文件
   */
  const handleCancelDeleteFiles = useCallback(() => {
    setIsDeleteFilesModalOpen(false)
    setFilesToDeleteCount(0)
  }, [])

  /**
   * 处理重命名
   */
  const handleRename = useCallback(
    async (newName: string) => {
      if (!renameTarget) {
        return
      }

      try {
        await renameFile(renameTarget.path, newName)
        setRenameTarget(null)
      } catch (err) {
        showError(err instanceof Error ? err.message : '重命名失败')
      }
    },
    [renameTarget, renameFile, showError]
  )

  /**
   * 处理文件拖拽进入。
   */
  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setIsDropActive(true)
  }, [])

  /**
   * 处理文件拖拽离开。
   */
  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDropActive(false)
  }, [])

  /**
   * 内部拖拽：开始拖拽文件项
   */
  const handleInternalDragStart = useCallback((e: React.DragEvent, file: FileItem) => {
    const filePaths = selectedFiles.has(file.path) && selectedFiles.size > 1
      ? Array.from(selectedFiles)
      : [file.path]
    e.dataTransfer.setData('application/x-mtbot-files', JSON.stringify(filePaths))
    e.dataTransfer.effectAllowed = 'move'
  }, [selectedFiles])

  /**
   * 内部拖拽：文件悬停在文件夹上
   */
  const handleFolderDragOver = useCallback((e: React.DragEvent, folderPath: string) => {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setDragOverFolderPath(folderPath)
  }, [])

  /**
   * 内部拖拽：文件拖离文件夹
   */
  const handleFolderDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOverFolderPath(null)
  }, [])

  /**
   * 内部拖拽：文件放入文件夹
   */
  const handleFolderDrop = useCallback(async (e: React.DragEvent, targetFolderPath: string) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOverFolderPath(null)
    const raw = e.dataTransfer.getData('application/x-mtbot-files')
    if (!raw) {
      return
    }
    try {
      const sourcePaths: string[] = JSON.parse(raw)
      for (const sourcePath of sourcePaths) {
        const fileName = sourcePath.replace(/\\/g, '/').split('/').pop() || 'file'
        const targetPath = `${targetFolderPath.replace(/\\/g, '/')}/${fileName}`
        if (sourcePath.replace(/\\/g, '/') === targetPath) {
          continue
        }
        await moveFile(sourcePath, targetPath)
      }
      await refresh()
    } catch (err) {
      showError(err instanceof Error ? err.message : '移动文件失败')
    }
  }, [moveFile, refresh, showError])

  /**
   * 处理拖拽文件到当前目录。
   */
  const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDropActive(false)
    setDragOverFolderPath(null)

    // 内部拖拽：移动文件到当前目录
    const internalData = e.dataTransfer.getData('application/x-mtbot-files')
    if (internalData) {
      try {
        const sourcePaths: string[] = JSON.parse(internalData)
        for (const sourcePath of sourcePaths) {
          const fileName = sourcePath.replace(/\\/g, '/').split('/').pop() || 'file'
          const targetPath = `${currentPath.replace(/\\/g, '/')}/${fileName}`
          if (sourcePath.replace(/\\/g, '/') === targetPath) {
            continue
          }
          await moveFile(sourcePath, targetPath)
        }
        await refresh()
      } catch (err) {
        showError(err instanceof Error ? err.message : '移动文件失败')
      }
      return
    }

    // 外部拖拽：复制文件到当前目录
    const droppedFiles = Array.from(e.dataTransfer.files)
    if (droppedFiles.length === 0) {
      return
    }
    try {
      for (const file of droppedFiles) {
        const sourcePath = (file as File & { path?: string }).path
        if (!sourcePath) {
          continue
        }
        const targetPath = `${currentPath.replace(/\\/g, '/')}/${file.name}`
        await copyFile(sourcePath, targetPath)
      }
      await refresh()
    } catch (err) {
      showError(err instanceof Error ? err.message : '拖拽上传失败')
    }
  }, [copyFile, moveFile, currentPath, refresh, showError])

  /**
   * 处理文件列表滚动事件（用于虚拟滚动）。
   */
  const handleListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setListScrollTop(e.currentTarget.scrollTop)
  }, [])

  /**
   * 粘贴剪贴板中的文件到当前目录。
   */
  const handlePasteFiles = useCallback(async () => {
    if (!pendingTransfer || pendingTransfer.sourcePaths.length === 0) {
      return
    }
    try {
      for (const sourcePath of pendingTransfer.sourcePaths) {
        const fileName = sourcePath.replace(/\\/g, '/').split('/').pop() || 'file'
        const targetPath = `${currentPath.replace(/\\/g, '/')}/${fileName}`
        if (pendingTransfer.mode === 'copy') {
          await copyFile(sourcePath, targetPath)
        } else {
          await moveFile(sourcePath, targetPath)
        }
      }
      if (pendingTransfer.mode === 'cut') {
        setPendingTransfer(null)
      }
      await refresh()
    } catch (err) {
      showError(err instanceof Error ? err.message : '粘贴失败')
    }
  }, [copyFile, currentPath, moveFile, pendingTransfer, refresh, showError])

  /**
   * 保存编辑后的预览内容到文件。
   */
  const handleSavePreview = useCallback(async () => {
    if (!previewTargetPath) return
    setIsSavingPreview(true)
    try {
      await window.electronAPI.file.write(previewTargetPath, editingContent)
      setPreviewContent(editingContent)
      setIsEditingPreview(false)
    } catch (err) {
      showError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setIsSavingPreview(false)
    }
  }, [previewTargetPath, editingContent, showError])

  /**
   * 点击背景时关闭右键菜单
   */
  useEffect(() => {
    const handleClick = () => closeContextMenu()
    document.addEventListener('click', handleClick)
    return () => document.removeEventListener('click', handleClick)
  }, [closeContextMenu])

  /**
   * 键盘快捷键
   */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'a') {
        e.preventDefault()
        selectAll()
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        void handlePasteFiles()
      }
      if (e.key === 'Delete' && selectedFiles.size > 0) {
        handleDelete()
      }
      if (e.key === 'F2' && selectedFiles.size === 1) {
        const filePath = Array.from(selectedFiles)[0]
        const file = files.find((f) => f.path === filePath)
        if (file) {
          setRenameTarget(file)
        }
      }
      if (e.key === 'Escape') {
        clearSelection()
        setContextMenu(null)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [selectAll, clearSelection, selectedFiles, files, handleDelete, handlePasteFiles])

  /**
   * 加载文本文件预览内容。
   */
  useEffect(() => {
    setIsEditingPreview(false)
    setEditingContent('')
    let cancelled = false
    async function loadPreview(): Promise<void> {
      if (!previewTargetPath) {
        setPreviewContent(null)
        setIsPreviewLoading(false)
        return
      }
      setIsPreviewLoading(true)
      try {
        const content = await readFile(previewTargetPath)
        if (!cancelled) {
          setPreviewContent(content)
        }
      } catch {
        if (!cancelled) {
          setPreviewContent('预览加载失败，请双击使用系统程序打开。')
        }
      } finally {
        if (!cancelled) {
          setIsPreviewLoading(false)
        }
      }
    }
    void loadPreview()
    return () => {
      cancelled = true
    }
  }, [previewTargetPath, previewTargetModifiedAt, readFile])

  /**
   * 初始化并更新列表容器高度，供虚拟滚动计算可视区。
   */
  useEffect(() => {
    const updateHeight = (): void => {
      if (!listRef.current) {
        return
      }
      setListViewportHeight(listRef.current.clientHeight)
    }
    updateHeight()
    window.addEventListener('resize', updateHeight)
    return () => window.removeEventListener('resize', updateHeight)
  }, [])

  // 工作空间初始化中，或 workspaceDir 尚未就绪（避免空文件列表）
  if (isInitializing || !workspaceDir) {
    return (
      <div className={styles['files-view']}>
        <div className={styles['workspace-loading']}>
          <span className={styles['spinner']}>⏳</span>
          <p>初始化工作空间...</p>
        </div>
      </div>
    )
  }

  // 工作空间初始化失败
  if (initError) {
    return (
      <div className={styles['files-view']}>
        <div className={styles['workspace-error']}>
          <span className={styles['icon']}>❌</span>
          <p>工作空间初始化失败: {initError}</p>
        </div>
      </div>
    )
  }

  return (
    <div className={styles['files-view']}>
      {/* 工具栏 */}
      <div className={styles['files-toolbar']}>
        <div className={styles['toolbar-navigation']}>
          <Button
            variant="ghost"
            size="sm"
            onClick={goBack}
            disabled={historyIndex <= 0}
            title="返回"
          >
            ← 返回
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={goForward}
            disabled={historyIndex >= history.length - 1}
            title="前进"
          >
            → 前进
          </Button>
          <Button variant="ghost" size="sm" onClick={goUp} title="上一级目录">
            ↑ 上一级
          </Button>
          <Button variant="ghost" size="sm" onClick={refresh} disabled={isLoading} title="刷新目录">
            {isLoading ? '⏳ 刷新中' : '🔄 刷新'}
          </Button>
        </div>

        <div className={styles['breadcrumb']} aria-label="路径导航">
          <button
            className={clsx(styles['breadcrumb-item'], styles['breadcrumb-root'])}
            onClick={() => void handleBreadcrumbNavigate(-1)}
            title="回到全部文件"
          >
            全部文件
          </button>
          {buildBreadcrumbSegments(toRelativePath(currentPath)).map((segment, index) => (
            <React.Fragment key={`${segment}-${index}`}>
              <span className={styles['breadcrumb-separator']}>›</span>
              <button
                className={styles['breadcrumb-item']}
                onClick={() => void handleBreadcrumbNavigate(index)}
                title={segment}
              >
                {segment}
              </button>
            </React.Fragment>
          ))}
        </div>

        <div className={styles['toolbar-actions']}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowNewFolderDialog(true)}
            title="新建文件夹"
          >
            📁 新建文件夹
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDelete}
            disabled={selectedFiles.size === 0}
            title="删除"
          >
            🗑️ 删除
          </Button>
        </div>
      </div>

      {/* 主体内容 */}
      <div className={styles['files-content']}>
        {/* 侧边栏 - 工作空间导航 */}
        <div className={styles['files-sidebar']}>
          <h4>我的文件</h4>
          <nav className={styles['quick-locations']}>
            {USER_QUICK_LOCATIONS.map((loc) => (
              <button
                key={loc.id}
                className={clsx(
                  styles['quick-location-item'],
                  viewMode === 'workspace' && currentPath === toAbsolutePath(loc.relativePath) && styles['active'],
                )}
                onClick={() => {
                  setViewMode('workspace')
                  void handleLocationClick(loc)
                }}
              >
                <span className={styles['loc-icon']}>{loc.icon}</span>
                <span className={styles['loc-label']}>{loc.label}</span>
              </button>
            ))}
            <button
              className={clsx(styles['quick-location-item'], viewMode === 'agent' && styles['active'])}
              onClick={() => setViewMode('agent')}
            >
              <span className={styles['loc-icon']}>🤖</span>
              <span className={styles['loc-label']}>AI 生成文件</span>
            </button>
          </nav>

        </div>

        {/* 文件列表 */}
        {viewMode === 'agent' ? (
          <AgentFilesView userId="local-user" />
        ) : null}
        <div className={clsx(styles['files-list-container'], viewMode === 'agent' && styles['hidden'])}>
          {/* 排序栏 */}
          <div className={styles['files-header']}>
            <button
              className={clsx(styles['sort-btn'], sortBy === 'name' && styles['active'])}
              onClick={() => setSorting('name')}
            >
              名称 {sortBy === 'name' && (sortOrder === 'asc' ? '↑' : '↓')}
            </button>
            <button
              className={clsx(styles['sort-btn'], sortBy === 'size' && styles['active'])}
              onClick={() => setSorting('size')}
            >
              大小 {sortBy === 'size' && (sortOrder === 'asc' ? '↑' : '↓')}
            </button>
            <button
              className={clsx(styles['sort-btn'], sortBy === 'date' && styles['active'])}
              onClick={() => setSorting('date')}
            >
              修改日期 {sortBy === 'date' && (sortOrder === 'asc' ? '↑' : '↓')}
            </button>
          </div>

          {/* 错误提示 */}
          {error && (
            <ErrorBanner
              message={error.message || String(error)}
              onRetry={refresh}
            />
          )}

          {/* 文件列表 */}
          <div
            ref={listRef}
            className={clsx(styles['files-list'], isDropActive && styles['drop-active'])}
            onContextMenu={(e) => handleContextMenu(e, null)}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onScroll={handleListScroll}
          >
            {isLoading && files.length === 0 ? (
              <Loading text="加载文件列表..." />
            ) : files.length === 0 ? (
              <Empty icon="📂" description="文件夹为空" />
            ) : virtualRange ? (
              <div
                style={{
                  position: 'relative',
                  height: files.length * VIRTUAL_ROW_HEIGHT,
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    top: virtualRange.start * VIRTUAL_ROW_HEIGHT,
                    left: 0,
                    right: 0,
                  }}
                >
                  {files.slice(virtualRange.start, virtualRange.end).map((file) => (
                    <FileListItem
                      key={file.path}
                      file={file}
                      isSelected={selectedFiles.has(file.path)}
                      onSelect={(e) => handleFileClick(e, file)}
                      onDoubleClick={() => handleFileDoubleClick(file)}
                      onContextMenu={(e) => handleContextMenu(e, file)}
                      onDragStart={(e) => handleInternalDragStart(e, file)}
                      onDragOver={file.isDirectory ? (e) => handleFolderDragOver(e, file.path) : undefined}
                      onDrop={file.isDirectory ? (e) => { void handleFolderDrop(e, file.path) } : undefined}
                      onDragLeave={file.isDirectory ? handleFolderDragLeave : undefined}
                      isDragOver={dragOverFolderPath === file.path}
                    />
                  ))}
                </div>
              </div>
            ) : (
              files.map((file) => (
                <FileListItem
                  key={file.path}
                  file={file}
                  isSelected={selectedFiles.has(file.path)}
                  onSelect={(e) => handleFileClick(e, file)}
                  onDoubleClick={() => handleFileDoubleClick(file)}
                  onContextMenu={(e) => handleContextMenu(e, file)}
                  onDragStart={(e) => handleInternalDragStart(e, file)}
                  onDragOver={file.isDirectory ? (e) => handleFolderDragOver(e, file.path) : undefined}
                  onDrop={file.isDirectory ? (e) => { void handleFolderDrop(e, file.path) } : undefined}
                  onDragLeave={file.isDirectory ? handleFolderDragLeave : undefined}
                  isDragOver={dragOverFolderPath === file.path}
                />
              ))
            )}
          </div>

          {/* 状态栏 */}
          <div className={styles['files-statusbar']}>
            <span>{files.length} 个项目</span>
            {selectedFiles.size > 0 && <span>已选择 {selectedFiles.size} 项</span>}
          </div>
        </div>

        {/* 右侧预览面板 */}
        {previewTarget && (
          <div className={styles['file-preview']}>
            <div className={styles['preview-header']}>
              <span className={styles['preview-filename']}>{previewTarget.name}</span>
              {previewTarget.extension === 'md' && !isPreviewLoading && (
                isEditingPreview ? (
                  <>
                    <button
                      className={styles['preview-action-btn']}
                      onClick={() => void handleSavePreview()}
                      disabled={isSavingPreview}
                      title="保存"
                    >
                      {isSavingPreview ? '保存中...' : '💾 保存'}
                    </button>
                    <button
                      className={styles['preview-action-btn']}
                      onClick={() => { setIsEditingPreview(false); setEditingContent(previewContent ?? '') }}
                      title="取消"
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    className={styles['preview-action-btn']}
                    onClick={() => { setIsEditingPreview(true); setEditingContent(previewContent ?? '') }}
                    title="编辑"
                  >
                    ✏️ 编辑
                  </button>
                )
              )}
              <button
                className={styles['preview-close']}
                onClick={clearSelection}
                title="关闭预览"
              >
                ✕
              </button>
            </div>
            {isPreviewLoading ? (
              <div className={styles['preview-placeholder']}>正在加载预览...</div>
            ) : previewTarget.extension === 'md' ? (
              <div className={styles['preview-md-wrap']} data-color-mode={mdColorMode}>
                <MDEditor
                  value={isEditingPreview ? editingContent : (previewContent ?? '')}
                  onChange={isEditingPreview ? (val) => setEditingContent(val ?? '') : undefined}
                  preview={isEditingPreview ? 'live' : 'preview'}
                  height="100%"
                  visibleDragbar={false}
                  hideToolbar={!isEditingPreview}
                />
              </div>
            ) : (
              <pre className={styles['preview-content']}>{previewContent || '文件内容为空'}</pre>
            )}
          </div>
        )}
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          className={styles['context-menu']}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.file ? (
            <>
              <button
                onClick={() => {
                  if (contextMenu.file?.isDirectory) {
                    navigateTo(contextMenu.file.path)
                  } else {
                    window.electronAPI.app.openExternal(contextMenu.file!.path)
                  }
                  closeContextMenu()
                }}
              >
                {contextMenu.file.isDirectory ? '打开' : '打开文件'}
              </button>
              <button
                onClick={() => {
                  openInExplorer(contextMenu.file!.path)
                  closeContextMenu()
                }}
              >
                打开所在位置
              </button>
              <button
                onClick={() => {
                  copyPathToClipboard(contextMenu.file!.path)
                  closeContextMenu()
                }}
              >
                复制文件路径
              </button>
              <button
                onClick={() => {
                  setPendingTransfer({ mode: 'copy', sourcePaths: [contextMenu.file!.path] })
                  closeContextMenu()
                }}
              >
                复制
              </button>
              <button
                onClick={() => {
                  setPendingTransfer({ mode: 'cut', sourcePaths: [contextMenu.file!.path] })
                  closeContextMenu()
                }}
              >
                剪切
              </button>
              <button
                onClick={() => {
                  setRenameTarget(contextMenu.file)
                  closeContextMenu()
                }}
              >
                重命名
              </button>
              <hr />
              <button
                onClick={() => {
                  if (!selectedFiles.has(contextMenu.file!.path)) {
                    toggleSelect(contextMenu.file!.path)
                  }
                  handleDelete()
                  closeContextMenu()
                }}
                className={styles['danger']}
              >
                删除
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  setShowNewFolderDialog(true)
                  closeContextMenu()
                }}
              >
                新建文件夹
              </button>
              <button
                onClick={() => {
                  refresh()
                  closeContextMenu()
                }}
              >
                刷新
              </button>
              <button
                onClick={() => {
                  void handlePasteFiles()
                  closeContextMenu()
                }}
                disabled={!pendingTransfer}
              >
                {pendingTransfer ? '粘贴' : '粘贴（无内容）'}
              </button>
              <hr />
              <button
                onClick={() => {
                  selectAll()
                  closeContextMenu()
                }}
              >
                全选
              </button>
            </>
          )}
        </div>
      )}

      {/* 新建文件夹对话框 */}
      <NewFolderDialog
        open={showNewFolderDialog}
        onConfirm={handleCreateFolder}
        onCancel={() => setShowNewFolderDialog(false)}
      />

      {/* 重命名对话框 */}
      <RenameDialog
        open={!!renameTarget}
        currentName={renameTarget?.name || ''}
        onConfirm={handleRename}
        onCancel={() => setRenameTarget(null)}
      />

      {/* Delete Files Confirm Modal */}
      <ConfirmModal
        open={isDeleteFilesModalOpen}
        title="确认删除文件"
        content={`确定要删除 ${filesToDeleteCount} 个文件/文件夹吗？此操作不可恢复。`}
        confirmText="删除"
        cancelText="取消"
        confirmVariant="danger"
        onConfirm={handleConfirmDeleteFiles}
        onCancel={handleCancelDeleteFiles}
      />
    </div>
  )
}

export default FilesPage
