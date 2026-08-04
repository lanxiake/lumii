/**
 * useFiles.ts - 文件管理 Hook
 *
 * 管理文件浏览和操作的自定义 Hook
 * 使用通用 Hook 模式重构
 */

import { useState, useCallback, useEffect } from 'react'
import { useQuery } from '../../common/useQuery'
import type {
  FileItem,
  UserPaths,
  FileSortBy,
  SortOrder,
  FileManagerConfig,
  SearchOptions,
} from './useFiles.types'

function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.')
  if (lastDot === -1 || lastDot === 0) return ''
  return filename.slice(lastDot + 1).toLowerCase()
}

function getFileIcon(item: FileItem): string {
  if (item.isDirectory) return '📁'

  const ext = item.extension || getExtension(item.name)
  const iconMap: Record<string, string> = {
    txt: '📄', md: '📝', doc: '📄', docx: '📄', pdf: '📕',
    xls: '📊', xlsx: '📊', ppt: '📊', pptx: '📊',
    js: '📜', ts: '📜', jsx: '📜', tsx: '📜', json: '📋',
    html: '🌐', css: '🎨', py: '🐍', java: '☕',
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', svg: '🖼️',
    mp4: '🎬', mp3: '🎵', zip: '📦', rar: '📦',
  }

  return iconMap[ext] || '📄'
}

function parseFileItem(raw: {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modifiedAt: string
  createdAt: string
}): FileItem {
  const ext = raw.isDirectory ? undefined : getExtension(raw.name)
  const item: FileItem = {
    name: raw.name,
    path: raw.path,
    isDirectory: raw.isDirectory,
    size: raw.size,
    modifiedAt: new Date(raw.modifiedAt),
    createdAt: new Date(raw.createdAt),
    extension: ext,
    icon: '',
  }
  item.icon = getFileIcon(item)
  return item
}

export function useFiles(config?: FileManagerConfig) {
  const [currentPath, setCurrentPath] = useState(config?.initialPath || '')
  const [sortBy, setSortBy] = useState<FileSortBy>('name')
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc')
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)

  const rootPath = config?.rootPath
  const watchIntervalMs = config?.watchIntervalMs ?? 2000

  // 使用 useQuery 获取用户路径
  const { data: userPaths } = useQuery<UserPaths | null>({
    queryKey: ['files', 'userPaths'],
    queryFn: async () => {
      if (config?.initialPath) return null
      return window.electronAPI.system.getUserPaths()
    },
    enabled: !config?.initialPath,
  })

  // 使用 useQuery 获取当前目录文件列表
  const {
    data: files = [],
    isLoading,
    error,
    refetch,
  } = useQuery<FileItem[]>({
    queryKey: ['files', 'list', currentPath],
    queryFn: async () => {
      if (!currentPath) return []

      const rawFiles = (await window.electronAPI.file.list(currentPath)) as Array<{
        name: string
        path: string
        isDirectory: boolean
        size: number
        modifiedAt: string
        createdAt: string
      }>

      return rawFiles.map(parseFileItem)
    },
    enabled: !!currentPath,
    refetchInterval: watchIntervalMs > 0 ? watchIntervalMs : 0,
  })

  // 排序文件
  const sortedFiles = (files || []).slice().sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1
    }

    let comparison = 0
    switch (sortBy) {
      case 'name':
        comparison = a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
        break
      case 'size':
        comparison = a.size - b.size
        break
      case 'date':
        comparison = a.modifiedAt.getTime() - b.modifiedAt.getTime()
        break
      case 'type':
        comparison = (a.extension || '').localeCompare(b.extension || '')
        break
    }

    return sortOrder === 'asc' ? comparison : -comparison
  })

  // 初始化导航：仅在 config.initialPath 明确指定时导航，不自动 fallback 到用户主目录
  useEffect(() => {
    if (config?.initialPath) {
      navigateTo(config.initialPath)
    }
  }, [config?.initialPath])

  /** 导航到指定路径 */
  const navigateTo = useCallback(
    async (path: string) => {
      // 根路径约束
      if (rootPath) {
        const normalizedPath = path.replace(/\\/g, '/')
        const normalizedRoot = rootPath.replace(/\\/g, '/')
        if (!normalizedPath.startsWith(normalizedRoot)) {
          console.warn('[useFiles] 阻止导航到工作空间外:', path)
          return
        }
      }

      setCurrentPath(path)
      setSelectedFiles(new Set())

      // 更新历史
      setHistory((prev) => {
        const newHistory = prev.slice(0, historyIndex + 1)
        newHistory.push(path)
        return newHistory
      })
      setHistoryIndex((prev) => prev + 1)
    },
    [rootPath, historyIndex]
  )

  /** 返回上一级 */
  const goUp = useCallback(() => {
    if (!currentPath) return

    // 根路径约束
    if (rootPath) {
      const normalizedCurrent = currentPath.replace(/\\/g, '/')
      const normalizedRoot = rootPath.replace(/\\/g, '/')
      if (
        normalizedCurrent === normalizedRoot ||
        normalizedCurrent === normalizedRoot + '/'
      ) {
        return
      }
    }

    const normalized = currentPath.replace(/\\/g, '/')
    const parts = normalized.split('/').filter(Boolean)
    if (parts.length <= 1) {
      navigateTo(parts[0] + '/')
    } else {
      parts.pop()
      const parentPath = parts.join('/')
      navigateTo(parentPath.includes(':') ? parentPath : '/' + parentPath)
    }
  }, [currentPath, navigateTo, rootPath])

  /** 返回上一个历史记录 */
  const goBack = useCallback(() => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1
      setHistoryIndex(newIndex)
      setCurrentPath(history[newIndex])
    }
  }, [historyIndex, history])

  /** 前进到下一个历史记录 */
  const goForward = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1
      setHistoryIndex(newIndex)
      setCurrentPath(history[newIndex])
    }
  }, [historyIndex, history])

  /** 设置排序 */
  const setSorting = useCallback(
    (newSortBy: FileSortBy, order?: SortOrder) => {
      const newOrder =
        order || (sortBy === newSortBy && sortOrder === 'asc' ? 'desc' : 'asc')
      setSortBy(newSortBy)
      setSortOrder(newOrder)
    },
    [sortBy, sortOrder]
  )

  /** 切换文件选中状态 */
  const toggleSelect = useCallback((path: string) => {
    setSelectedFiles((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(path)) {
        newSet.delete(path)
      } else {
        newSet.add(path)
      }
      return newSet
    })
  }, [])

  /** 选中所有文件 */
  const selectAll = useCallback(() => {
    setSelectedFiles(new Set((files ?? []).map((f) => f.path)))
  }, [files])

  /** 取消所有选中 */
  const clearSelection = useCallback(() => {
    setSelectedFiles(new Set())
  }, [])

  /** 创建文件夹 */
  const createFolder = useCallback(
    async (name: string) => {
      const newPath = currentPath.replace(/\\/g, '/') + '/' + name
      await window.electronAPI.file.createDir(newPath)
      await refetch()
    },
    [currentPath, refetch]
  )

  /** 删除选中的文件 */
  const deleteSelected = useCallback(async () => {
    for (const path of selectedFiles) {
      await window.electronAPI.file.delete(path)
    }
    setSelectedFiles(new Set())
    await refetch()
  }, [selectedFiles, refetch])

  /** 重命名文件 */
  const renameFile = useCallback(
    async (oldPath: string, newName: string) => {
      const dir = oldPath.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
      const newPath = dir + '/' + newName
      await window.electronAPI.file.move(oldPath, newPath)
      await refetch()
    },
    [refetch]
  )

  /** 复制文件 */
  const copyFiles = useCallback(
    async (sourcePaths: string[], destDir: string) => {
      for (const sourcePath of sourcePaths) {
        const fileName = sourcePath.replace(/\\/g, '/').split('/').pop()
        const destPath = destDir.replace(/\\/g, '/') + '/' + fileName
        await window.electronAPI.file.copy(sourcePath, destPath)
      }
      await refetch()
    },
    [refetch]
  )

  /** 移动文件 */
  const moveFiles = useCallback(
    async (sourcePaths: string[], destDir: string) => {
      for (const sourcePath of sourcePaths) {
        const fileName = sourcePath.replace(/\\/g, '/').split('/').pop()
        const destPath = destDir.replace(/\\/g, '/') + '/' + fileName
        await window.electronAPI.file.move(sourcePath, destPath)
      }
      setSelectedFiles(new Set())
      await refetch()
    },
    [refetch]
  )

  /**
   * 复制单个文件到目标路径。
   */
  const copyFile = useCallback(async (sourcePath: string, targetPath: string): Promise<void> => {
    await window.electronAPI.file.copy(sourcePath, targetPath)
    await refetch()
  }, [refetch])

  /**
   * 移动单个文件到目标路径。
   */
  const moveFile = useCallback(async (sourcePath: string, targetPath: string): Promise<void> => {
    await window.electronAPI.file.move(sourcePath, targetPath)
    await refetch()
  }, [refetch])

  /**
   * 执行批量文件操作（复制/移动/删除）。
   */
  const batchOperation = useCallback(async (
    operation: 'copy' | 'move' | 'delete',
    files: string[],
    targetPath?: string,
  ): Promise<void> => {
    if (files.length === 0) {
      return
    }
    if ((operation === 'copy' || operation === 'move') && !targetPath) {
      throw new Error('批量复制/移动必须提供目标路径')
    }
    for (const filePath of files) {
      if (operation === 'delete') {
        await window.electronAPI.file.delete(filePath)
        continue
      }
      const fileName = filePath.replace(/\\/g, '/').split('/').pop()
      const destPath = `${(targetPath || '').replace(/\\/g, '/')}/${fileName || 'file'}`
      if (operation === 'copy') {
        await window.electronAPI.file.copy(filePath, destPath)
      } else {
        await window.electronAPI.file.move(filePath, destPath)
      }
    }
    if (operation !== 'copy') {
      setSelectedFiles(new Set())
    }
    await refetch()
  }, [refetch])

  /**
   * 在资源管理器中打开文件所在目录。
   */
  const openInExplorer = useCallback((path: string): void => {
    window.electronAPI.app.showItemInFolder(path)
  }, [])

  /**
   * 复制文件路径到系统剪贴板。
   */
  const copyPathToClipboard = useCallback((path: string): void => {
    void window.electronAPI.clipboard.writeText(path)
  }, [])

  /** 搜索文件 */
  const searchFiles = useCallback(
    async (pattern: string, options?: SearchOptions): Promise<FileItem[]> => {
      const results = (await window.electronAPI.file.search(
        currentPath,
        pattern,
        {
          recursive: options?.recursive ?? true,
          maxResults: options?.maxResults ?? 100,
        }
      )) as Array<{
        name: string
        path: string
        isDirectory: boolean
        size: number
        modifiedAt: string
        createdAt: string
      }>

      return results.map(parseFileItem)
    },
    [currentPath]
  )

  /** 读取文件内容 */
  const readFile = useCallback(async (path: string): Promise<string> => {
    return window.electronAPI.file.read(path)
  }, [])

  /** 获取文件信息 */
  const getFileInfo = useCallback(async (path: string): Promise<FileItem | null> => {
    try {
      const info = (await window.electronAPI.file.getInfo(path)) as {
        name: string
        path: string
        isDirectory: boolean
        size: number
        modifiedAt: string
        createdAt: string
      }
      return parseFileItem(info)
    } catch {
      return null
    }
  }, [])

  return {
    currentPath,
    files: sortedFiles,
    isLoading,
    error,
    userPaths,
    selectedFiles,
    sortBy,
    sortOrder,
    history,
    historyIndex,
    navigateTo,
    refresh: refetch,
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
    copyFiles,
    moveFiles,
    copyFile,
    moveFile,
    batchOperation,
    searchFiles,
    readFile,
    getFileInfo,
    openInExplorer,
    copyPathToClipboard,
  }
}

export type UseFilesReturn = ReturnType<typeof useFiles>

/** 格式化文件大小 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}
