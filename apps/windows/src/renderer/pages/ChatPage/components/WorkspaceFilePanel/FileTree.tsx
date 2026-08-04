/**
 * FileTree — 懒加载树形目录组件
 *
 * - 文件夹首次展开时按需加载子内容（window.electronAPI.file.list）
 * - 展开状态用 Set<string> 维护，目录内容缓存在 Map<string, FileItem[]>
 * - 图标使用 SVG（lucide-react），不使用 emoji
 * - refreshToken 变化时清空缓存，重新加载已展开目录
 */

import React, { useState, useCallback, useEffect } from 'react'
import clsx from 'clsx'
import type { FileItem } from '../../../../hooks/business/useFiles/useFiles.types'
import styles from './FileTree.module.css'

// ── SVG 图标（内联，无外部依赖） ──────────────────────────────────────────

const IconChevronRight: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 18 15 12 9 6" />
  </svg>
)

const IconFolder: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
)

const IconFolderOpen: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    <polyline points="2 10 12 10 22 10" />
  </svg>
)

const IconFile: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
    <polyline points="13 2 13 9 20 9" />
  </svg>
)

const IconFileText: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
    <polyline points="10 9 9 9 8 9" />
  </svg>
)

const IconFileCode: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <polyline points="10 13 8 15 10 17" />
    <polyline points="14 13 16 15 14 17" />
  </svg>
)

const IconImage: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <polyline points="21 15 16 10 5 21" />
  </svg>
)

const IconMoreHorizontal: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
    <circle cx="5" cy="12" r="1" />
  </svg>
)

// ── 文件图标映射 ──────────────────────────────────────────────────────────

function FileIcon({ extension, isDir, isExpanded }: { extension?: string; isDir: boolean; isExpanded?: boolean }) {
  if (isDir) {
    return (
      <span className={clsx(styles.fileIcon, styles['fileIcon--dir'])}>
        {isExpanded ? <IconFolderOpen size={14} /> : <IconFolder size={14} />}
      </span>
    )
  }
  const ext = extension?.toLowerCase() ?? ''
  let icon = <IconFile size={14} />
  if (['md', 'txt', 'log'].includes(ext)) icon = <IconFileText size={14} />
  else if (['ts', 'tsx', 'js', 'jsx', 'json', 'py', 'css', 'html', 'xml', 'yaml', 'yml', 'sh', 'bash'].includes(ext)) icon = <IconFileCode size={14} />
  else if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp'].includes(ext)) icon = <IconImage size={14} />
  return <span className={styles.fileIcon}>{icon}</span>
}

// ── 解析 FileItem ─────────────────────────────────────────────────────────

function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.')
  if (lastDot === -1 || lastDot === 0) return ''
  return filename.slice(lastDot + 1).toLowerCase()
}

function parseRawItem(raw: {
  name: string; path: string; isDirectory: boolean
  size: number; modifiedAt: string; createdAt: string
}): FileItem {
  const ext = raw.isDirectory ? undefined : getExtension(raw.name)
  return {
    name: raw.name,
    path: raw.path,
    isDirectory: raw.isDirectory,
    size: raw.size,
    modifiedAt: new Date(raw.modifiedAt),
    createdAt: new Date(raw.createdAt),
    extension: ext,
    icon: '',
  }
}

// ── 单节点（递归） ────────────────────────────────────────────────────────

// ── 相对路径（用于拖入输入框作 @引用） ──
function toRelative(rootPath: string, absPath: string): string {
  const root = rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const abs = absPath.replace(/\\/g, '/')
  return abs.startsWith(root + '/') ? abs.slice(root.length + 1) : abs
}

interface FileTreeNodeProps {
  item: FileItem
  depth: number
  rootPath: string
  isExpanded: boolean
  isSelected: boolean
  isLoading: boolean
  children: FileItem[]
  expandedDirs: Set<string>
  dirContents: Map<string, FileItem[]>
  loadingDirs: Set<string>
  selectedPath: string | null
  onToggle: (path: string) => void
  onSelect: (item: FileItem) => void
  onContextMenu: (e: React.MouseEvent, item: FileItem) => void
  onMoreClick: (e: React.MouseEvent, item: FileItem) => void
}

const FileTreeNode: React.FC<FileTreeNodeProps> = ({
  item, depth, rootPath, isExpanded, isSelected, isLoading, children,
  expandedDirs, dirContents, loadingDirs, selectedPath,
  onToggle, onSelect, onContextMenu, onMoreClick,
}) => {
  const indent = depth * 16 + 8

  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (item.isDirectory) {
      onToggle(item.path)
    } else {
      onSelect(item)
    }
  }, [item, onToggle, onSelect])

  const handleArrowClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    onToggle(item.path)
  }, [item.path, onToggle])

  const handleDragStart = useCallback((e: React.DragEvent) => {
    const relativePath = toRelative(rootPath, item.path)
    const payload = JSON.stringify({
      relativePath,
      name: item.name,
      absolutePath: item.path,
      isDirectory: item.isDirectory,
    })
    e.dataTransfer.setData('application/x-mtbot-file', payload)
    e.dataTransfer.setData('text/plain', `@${relativePath}`)
    e.dataTransfer.effectAllowed = 'copy'
  }, [rootPath, item.path, item.name, item.isDirectory])

  return (
    <>
      <div
        className={clsx(styles.node, isSelected && styles['node--selected'])}
        style={{ paddingLeft: indent }}
        data-tree-path={item.path}
        draggable
        onDragStart={handleDragStart}
        onClick={handleClick}
        onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, item) }}
        title={item.name}
      >
        {/* 展开箭头 */}
        {item.isDirectory ? (
          <span
            className={clsx(styles.arrow, isExpanded && styles['arrow--expanded'])}
            onClick={handleArrowClick}
          >
            <IconChevronRight size={12} />
          </span>
        ) : (
          <span className={styles.arrowPlaceholder} />
        )}

        {/* 文件图标 */}
        <FileIcon extension={item.extension} isDir={item.isDirectory} isExpanded={isExpanded} />

        {/* 文件名 */}
        <span className={styles.name}>{item.name}</span>

        {/* 悬停操作按钮 */}
        <div className={styles.actions} onClick={(e) => e.stopPropagation()}>
          <button
            className={styles.actionBtn}
            title="更多操作"
            onClick={(e) => onMoreClick(e, item)}
          >
            <IconMoreHorizontal size={13} />
          </button>
        </div>
      </div>

      {/* 子节点 */}
      {item.isDirectory && isExpanded && (
        <>
          {isLoading && (
            <div className={styles.loadingRow} style={{ paddingLeft: indent + 20 }}>
              <span className={styles.loadingSpinner} />
              <span>加载中...</span>
            </div>
          )}
          {!isLoading && children.length === 0 && (
            <div className={styles.emptyDir} style={{ paddingLeft: indent + 20 }}>
              空文件夹
            </div>
          )}
          {!isLoading && children.map((child) => (
            <FileTreeNode
              key={child.path}
              item={child}
              depth={depth + 1}
              rootPath={rootPath}
              isExpanded={expandedDirs.has(child.path)}
              isSelected={selectedPath === child.path}
              isLoading={loadingDirs.has(child.path)}
              children={dirContents.get(child.path) ?? []}
              expandedDirs={expandedDirs}
              dirContents={dirContents}
              loadingDirs={loadingDirs}
              selectedPath={selectedPath}
              onToggle={onToggle}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
              onMoreClick={onMoreClick}
            />
          ))}
        </>
      )}
    </>
  )
}

// ── FileTree 主组件 ───────────────────────────────────────────────────────

export interface FileTreeProps {
  rootPath: string
  selectedPath: string | null
  /** 外部请求定位的目标路径：展开其所有祖先目录并滚动到该节点 */
  revealPath?: string | null
  revealToken?: number
  onSelect: (item: FileItem) => void
  onContextMenu: (e: React.MouseEvent, item: FileItem) => void
  onMoreClick: (e: React.MouseEvent, item: FileItem) => void
  refreshToken: number
}

export const FileTree: React.FC<FileTreeProps> = ({
  rootPath, selectedPath, revealPath, revealToken, onSelect, onContextMenu, onMoreClick, refreshToken,
}) => {
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set([rootPath]))
  const [dirContents, setDirContents] = useState<Map<string, FileItem[]>>(new Map())
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set())

  // 加载目录内容（force=true 时忽略 loadingDirs 去重，用于展开/刷新强制读取最新）
  const loadDir = useCallback(async (dirPath: string, force = false) => {
    if (!force && loadingDirs.has(dirPath)) return
    setLoadingDirs((prev) => new Set(prev).add(dirPath))
    try {
      const raw = await window.electronAPI.file.list(dirPath) as Array<{
        name: string; path: string; isDirectory: boolean
        size: number; modifiedAt: string; createdAt: string
      }>
      const items = raw
        .map(parseRawItem)
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
          return a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
        })
      setDirContents((prev) => new Map(prev).set(dirPath, items))
    } catch (err) {
      console.error('[FileTree] 加载目录失败:', dirPath, err)
      setDirContents((prev) => new Map(prev).set(dirPath, []))
    } finally {
      setLoadingDirs((prev) => { const s = new Set(prev); s.delete(dirPath); return s })
    }
  }, [loadingDirs])

  // 初始加载根目录
  useEffect(() => {
    if (rootPath) void loadDir(rootPath)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath])

  // refreshToken 变化时重新加载所有已展开目录
  useEffect(() => {
    if (refreshToken === 0) return
    setDirContents(new Map())
    const toReload = new Set(expandedDirs)
    toReload.forEach((dir) => {
      void (async () => {
        try {
          const raw = await window.electronAPI.file.list(dir) as Array<{
            name: string; path: string; isDirectory: boolean
            size: number; modifiedAt: string; createdAt: string
          }>
          const items = raw
            .map(parseRawItem)
            .sort((a, b) => {
              if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
              return a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
            })
          setDirContents((prev) => new Map(prev).set(dir, items))
        } catch {
          setDirContents((prev) => new Map(prev).set(dir, []))
        }
      })()
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken])

  // 展开/折叠目录
  const handleToggle = useCallback((dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(dirPath)) {
        next.delete(dirPath)
      } else {
        next.add(dirPath)
        // 展开时强制重载，保证读取的是最新磁盘内容（即使此前已缓存）
        void loadDir(dirPath, true)
      }
      return next
    })
  }, [loadDir])

  const rootItems = dirContents.get(rootPath) ?? []
  const isRootLoading = loadingDirs.has(rootPath)

  // 外部定位：展开目标的所有祖先目录，加载内容后滚动到该节点
  useEffect(() => {
    if (!revealPath || !rootPath) return
    const sep = rootPath.includes('\\') ? '\\' : '/'
    const root = rootPath.replace(/[\\/]+$/, '')
    if (!revealPath.startsWith(root)) return
    const rest = revealPath.slice(root.length).replace(/^[\\/]+/, '')
    const parts = rest.split(/[\\/]+/).filter(Boolean)
    // 逐级构造祖先目录（不含目标自身），全部展开 + 按需加载
    const ancestors: string[] = [root]
    let acc = root
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc + sep + parts[i]
      ancestors.push(acc)
    }
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      ancestors.forEach((d) => next.add(d))
      return next
    })
    ancestors.forEach((d) => { if (!dirContents.has(d)) void loadDir(d) })
    // 内容渲染后滚动到目标节点（稍作延迟等待懒加载完成）
    const timer = setTimeout(() => {
      const el = document.querySelector(`[data-tree-path="${CSS.escape(revealPath)}"]`)
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 250)
    return () => clearTimeout(timer)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealPath, revealToken])

  return (
    <div className={styles.tree}>
      {isRootLoading && (
        <div className={styles.loadingRow} style={{ paddingLeft: 8 }}>
          <span className={styles.loadingSpinner} />
          <span>加载中...</span>
        </div>
      )}
      {!isRootLoading && rootItems.map((item) => (
        <FileTreeNode
          key={item.path}
          item={item}
          depth={0}
          rootPath={rootPath}
          isExpanded={expandedDirs.has(item.path)}
          isSelected={selectedPath === item.path}
          isLoading={loadingDirs.has(item.path)}
          children={dirContents.get(item.path) ?? []}
          expandedDirs={expandedDirs}
          dirContents={dirContents}
          loadingDirs={loadingDirs}
          selectedPath={selectedPath}
          onToggle={handleToggle}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
          onMoreClick={onMoreClick}
        />
      ))}
    </div>
  )
}
