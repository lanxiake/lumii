/**
 * FileTree — 懒加载树形目录组件
 *
 * - 文件夹首次展开时按需加载子内容（file-service.listDirectory）
 * - 展开状态用 Set<string> 维护，目录内容缓存在 Map<string, FileItem[]>
 * - 图标使用 SVG（lucide-react），不使用 emoji
 * - refreshToken 变化时清空缓存，重新加载已展开目录
 */

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import clsx from 'clsx'
import type { FileItem } from '../../../../hooks/business/useFiles/useFiles.types'
import { useCodingDevProjects } from '../../../../hooks/business/useCodingDevProjects'
import { useWorkspaceVcs } from '../../../../hooks/business/useWorkspaceVcs'
import { listDirectory, moveFile } from '../../../../services/file-service'
import { getProjectGitStatus } from '../../../../services/app-service'
import type { ProjectGitStatus } from '@main/project-git/types'
import styles from './FileTree.module.css'

// key: 相对工作区根的路径（POSIX），工作区自身文件用原始相对路径；
// 挂载项目内的文件加 `projects/<name>/` 前缀，与文件树的绝对路径换算方式一致
type GitState = 'conflict' | 'added' | 'modified' | 'untracked' | 'ignored'

/** 真实 git（挂载项目）index/worktree 状态字符 → GitState */
function resolveRealGitState(s: { index: string; worktree: string }): GitState | undefined {
  if (s.index === 'U' || s.worktree === 'U' || (s.index === 'A' && s.worktree === 'A')) return 'conflict'
  if (s.index === 'A') return 'added'
  if (s.worktree === 'M' || s.index === 'M') return 'modified'
  if (s.index === '?' && s.worktree === '?') return 'untracked'
  if (s.index === '!' && s.worktree === '!') return 'ignored'
  return undefined
}

/** 文件或目录的 git 状态：直接查文件，目录扫描子树取最高优先级（冲突>新增>修改>未跟踪>忽略） */
function getGitState(
  relPath: string | null,
  isDirectory: boolean,
  gitMap: Map<string, GitState>,
): GitState | undefined {
  if (!relPath) return undefined
  if (!isDirectory) return gitMap.get(relPath)

  // 目录：先看是否有折叠条目直接命中（`?? dir/` `!! dir/`），否则聚合子树取最高优先级
  const dirKey = `${relPath}/`
  const direct = gitMap.get(dirKey)
  if (direct === 'ignored' || direct === 'untracked') return direct

  const prefix = dirKey
  let result: GitState | undefined
  for (const [path, state] of gitMap) {
    if (!path.startsWith(prefix)) continue
    if (state === 'conflict') return 'conflict'
    if (state === 'added') result = 'added'
    else if (state === 'modified' && result !== 'added') result = 'modified'
    else if (state === 'untracked' && !result) result = 'untracked'
    else if (state === 'ignored' && !result) result = 'ignored'
  }
  return result
}

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
  size: number; modifiedAt: string | Date; createdAt: string | Date
}): FileItem {
  const ext = raw.isDirectory ? undefined : getExtension(raw.name)
  return {
    name: raw.name,
    // 统一为正斜杠，避免 Windows 下 locateTarget(/) 与 file:list(\) 无法匹配
    path: raw.path.replace(/\\/g, '/'),
    isDirectory: raw.isDirectory,
    size: raw.size,
    modifiedAt: raw.modifiedAt instanceof Date ? raw.modifiedAt : new Date(raw.modifiedAt),
    createdAt: raw.createdAt instanceof Date ? raw.createdAt : new Date(raw.createdAt),
    extension: ext,
    icon: '',
  }
}

/** 路径比较用：统一分隔符并去掉尾部斜杠 */
function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** 取父目录路径（POSIX 规范化后） */
function parentOf(p: string): string {
  const n = normPath(p)
  const i = n.lastIndexOf('/')
  return i <= 0 ? n : n.slice(0, i)
}

/**
 * 拖拽移动后可局部刷新的目录集合；无效操作返回 null。
 * 无效：拖到自身 / 拖到自己子孙目录（Windows 会直接失败）/ 已在本目录（无变化）。
 * 除源父目录与目标目录外，还带上目标父目录——目标可能是刚建好、尚未加载的目录。
 */
export function moveRefreshDirs(dragPath: string, targetDir: string): string[] | null {
  const src = normPath(dragPath)
  const dest = normPath(targetDir)
  if (!src || !dest) return null
  if (dest === src || dest.startsWith(src + '/')) return null
  const srcParent = parentOf(src)
  if (srcParent === dest) return null
  return [...new Set([parentOf(dest), srcParent, dest])]
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
  gitMap: Map<string, GitState>
  onToggle: (path: string) => void
  onSelect: (item: FileItem) => void
  onContextMenu: (e: React.MouseEvent, item: FileItem) => void
  onMoreClick: (e: React.MouseEvent, item: FileItem) => void
  onDropMove: (dragPath: string, targetDir: string) => void
}

const FileTreeNode: React.FC<FileTreeNodeProps> = ({
  item, depth, rootPath, isExpanded, isSelected, isLoading, children,
  expandedDirs, dirContents, loadingDirs, selectedPath, gitMap,
  onToggle, onSelect, onContextMenu, onMoreClick, onDropMove,
}) => {
  const indent = depth * 16 + 8

  const relPath = toRelative(rootPath, item.path)
  const gitState = getGitState(relPath, item.isDirectory, gitMap)
  const isWikiRootFolder = item.isDirectory && relPath === 'wiki'
  const [isDropTarget, setIsDropTarget] = useState(false)

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
    // 文件树内的拖拽同时可作为「移动到文件夹」的来源；MIME 沿用同一份 payload，
    // 输入框只按 x-mtbot-file 解析，复制语义不受影响
    e.dataTransfer.effectAllowed = 'copyMove'
  }, [rootPath, item.path, item.name, item.isDirectory])

  // ── 拖拽移入文件夹：仅目录节点接受 ──
  // 树内拖拽（自带 x-mtbot-file）或系统文件管理器拖入的真实文件（Files）均可作来源
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!item.isDirectory) return
    const types = e.dataTransfer.types
    if (!types.includes('application/x-mtbot-file') && !types.includes('Files')) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setIsDropTarget(true)
  }, [item.isDirectory])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.stopPropagation()
    setIsDropTarget(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!item.isDirectory) return
    e.preventDefault()
    e.stopPropagation()
    setIsDropTarget(false)
    const raw = e.dataTransfer.getData('application/x-mtbot-file')
    if (raw) {
      try {
        const ref = JSON.parse(raw) as { absolutePath?: string }
        if (ref.absolutePath) onDropMove(ref.absolutePath, item.path)
      } catch (err) {
        console.error('[FileTree] 解析拖入文件失败:', err)
      }
    }
  }, [item.isDirectory, item.path, onDropMove])

  const handleDragEnd = useCallback(() => setIsDropTarget(false), [])

  return (
    <>
      <div
        className={clsx(
          styles.node,
          isSelected && styles['node--selected'],
          isWikiRootFolder && styles['node--wiki'],
          isDropTarget && styles['node--dropTarget'],
        )}
        style={{ paddingLeft: indent }}
        data-tree-path={item.path}
        draggable
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClick}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(e, item) }}
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

        {/* 文件名（按 git 状态着色） */}
        <span className={clsx(styles.name, gitState && styles[`name--git-${gitState}`])}>{item.name}</span>

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
              isExpanded={expandedDirs.has(normPath(child.path))}
              isSelected={!!selectedPath && normPath(selectedPath) === normPath(child.path)}
              isLoading={loadingDirs.has(normPath(child.path))}
              children={dirContents.get(normPath(child.path)) ?? []}
              expandedDirs={expandedDirs}
              dirContents={dirContents}
              loadingDirs={loadingDirs}
              selectedPath={selectedPath}
              gitMap={gitMap}
              onToggle={onToggle}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
              onMoreClick={onMoreClick}
              onDropMove={onDropMove}
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
  /** 局部刷新：仅重拉指定目录，不闪动 */
  dirRefresh: { dirs: string[]; token: number } | null
  /** 树内操作（移动等）完成后回调，参数为需要局部重拉的目录 */
  onTreeMutated: (dirs: string[]) => void
}

export const FileTree: React.FC<FileTreeProps> = ({
  rootPath, selectedPath, revealPath, revealToken, onSelect, onContextMenu, onMoreClick, refreshToken, dirRefresh, onTreeMutated,
}) => {
  const rootNorm = normPath(rootPath)
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set([rootNorm]))
  const [dirContents, setDirContents] = useState<Map<string, FileItem[]>>(new Map())
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set())
  const selectedNorm = selectedPath ? normPath(selectedPath) : null

  // Git 状态徽标数据源：工作区自身（isomorphic-git）+ 每个挂载项目（真实 git CLI）
  const { projects } = useCodingDevProjects()
  const { uncommittedDiff, refresh: refreshWorkspaceVcs } = useWorkspaceVcs()
  const [projectGitStatuses, setProjectGitStatuses] = useState<Map<string, ProjectGitStatus>>(new Map())

  const refreshProjectGitStatuses = useCallback(async () => {
    if (projects.length === 0) {
      setProjectGitStatuses(new Map())
      return
    }
    const entries = await Promise.all(
      projects.map(async (p) => [p.name, await getProjectGitStatus(p.name)] as const),
    )
    setProjectGitStatuses(new Map(entries))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects.map((p) => p.name).join(',')])

  useEffect(() => { void refreshProjectGitStatuses() }, [refreshProjectGitStatuses])

  // 合并为单个 Map：key 为相对工作区根的路径（POSIX）。
  // 工作区自身文件用原始相对路径；挂载项目内的文件加 `projects/<name>/` 前缀，
  // 与 toRelative(rootPath, item.path) 的换算结果对齐。
  const gitMap = useMemo<Map<string, GitState>>(() => {
    const map = new Map<string, GitState>()
    for (const d of uncommittedDiff) {
      // deleted 文件已不在磁盘上，文件树不会渲染对应节点，故此处只需处理 added/modified
      if (d.status === 'added') map.set(d.filepath, 'added')
      else if (d.status === 'modified') map.set(d.filepath, 'modified')
    }
    for (const p of projects) {
      const status = projectGitStatuses.get(p.name)
      if (!status?.available || !status.isRepo) continue
      for (const f of status.files) {
        const state = resolveRealGitState({ index: f.index, worktree: f.worktree })
        if (state) map.set(`projects/${p.name}/${f.path}`, state)
      }
    }
    return map
  }, [uncommittedDiff, projects, projectGitStatuses])

  // 加载目录内容（force=true 时忽略 loadingDirs 去重，用于展开/刷新强制读取最新）
  const loadDir = useCallback(async (dirPath: string, force = false) => {
    const key = normPath(dirPath)
    if (!force && loadingDirs.has(key)) return
    setLoadingDirs((prev) => new Set(prev).add(key))
    try {
      // 底层 file:list 在 Windows 上接受 / 与 \；统一用规范化路径请求
      const raw = await listDirectory(key)
      const items = raw
        .map(parseRawItem)
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
          return a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
        })
      setDirContents((prev) => new Map(prev).set(key, items))
    } catch (err) {
      // 目录不存在（尚未生成 / 已删除）属正常情况，降级为 warn，避免刷红控制台
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('ENOENT') || msg.includes('no such file')) {
        console.warn('[FileTree] 目录不存在，跳过:', dirPath)
      } else {
        console.error('[FileTree] 加载目录失败:', dirPath, err)
      }
      setDirContents((prev) => new Map(prev).set(key, []))
    } finally {
      setLoadingDirs((prev) => { const s = new Set(prev); s.delete(key); return s })
    }
  }, [loadingDirs])

  // 初始加载根目录
  useEffect(() => {
    if (rootPath) {
      setExpandedDirs(new Set([normPath(rootPath)]))
      void loadDir(rootPath)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath])

  // refreshToken 变化时重新加载所有已展开目录
  // 注意：不清空 dirContents —— 清空会让整棵树先卸载再重建，表现为闪动；
  // 保留旧内容 + loadDir 完成后再替换，节点 key 不变故不重新挂载，视觉上无跳变
  useEffect(() => {
    if (refreshToken === 0) return
    const toReload = new Set(expandedDirs)
    toReload.forEach((dir) => {
      void loadDir(dir, true)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken])

  // 局部刷新：只重拉受影响的目录（删除/移动后由父组件指定），不动整棵树
  useEffect(() => {
    if (!dirRefresh) return
    dirRefresh.dirs.forEach((dir) => {
      void loadDir(dir, true)
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirRefresh?.token])

  // 文件树刷新时同步刷新 git 状态，保证徽标与磁盘一致
  useEffect(() => {
    void refreshWorkspaceVcs()
    void refreshProjectGitStatuses()
  }, [refreshToken, refreshWorkspaceVcs, refreshProjectGitStatuses])

  // 展开/折叠目录
  const handleToggle = useCallback((dirPath: string) => {
    const key = normPath(dirPath)
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
        void loadDir(key, true)
      }
      return next
    })
  }, [loadDir])

  const rootItems = dirContents.get(rootNorm) ?? []
  const isRootLoading = loadingDirs.has(rootNorm)

  // 外部定位：展开目标的所有祖先目录，加载内容后滚动到该节点
  useEffect(() => {
    if (!revealPath || !rootPath) return
    const root = rootNorm
    const target = normPath(revealPath)
    if (target !== root && !target.startsWith(root + '/')) return

    const rest = target === root ? '' : target.slice(root.length + 1)
    const parts = rest.split('/').filter(Boolean)
    const ancestors: string[] = [root]
    let acc = root
    for (let i = 0; i < parts.length - 1; i++) {
      acc = `${acc}/${parts[i]}`
      ancestors.push(acc)
    }

    setExpandedDirs((prev) => {
      const next = new Set(prev)
      ancestors.forEach((d) => next.add(d))
      return next
    })

    // 串行加载祖先目录，确保嵌套目录（如 outputs/子目录）展开后再滚动
    let cancelled = false
    void (async () => {
      for (const d of ancestors) {
        if (cancelled) return
        await loadDir(d, true)
      }
      if (cancelled) return
      // 再等一帧让节点挂载
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-tree-path="${CSS.escape(target)}"]`)
        el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      })
    })()

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealPath, revealToken])

  // 点击树容器空白区域（未命中任何节点）触发根目录右键菜单，允许在根目录下新建文件/文件夹
  const handleTreeContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const rootItem: FileItem = {
      name: '',
      path: rootPath,
      isDirectory: true,
      size: 0,
      modifiedAt: new Date(),
      createdAt: new Date(),
    }
    onContextMenu(e, rootItem)
  }, [rootPath, onContextMenu])

  const handleDropMove = useCallback(async (dragPath: string, targetDir: string) => {
    const dirs = moveRefreshDirs(dragPath, targetDir)
    if (!dirs) return
    const src = normPath(dragPath)
    const dest = normPath(targetDir)
    const name = src.split('/').filter(Boolean).pop()
    if (!name) return
    try {
      await moveFile(src, `${dest}/${name}`)
    } catch (err) {
      // 顶层兜底：文件树内重名只能在 drop 时发现，静默失败会让人以为拖拽没生效
      console.error('[FileTree] 移动失败:', err)
      window.alert(`移动失败：${err instanceof Error ? err.message : String(err)}`)
      return
    }
    onTreeMutated(dirs)
  }, [onTreeMutated])

  const rootDropRef = useRef<HTMLDivElement>(null)
  const handleRootDragOver = useCallback((e: React.DragEvent) => {
    // 子节点已 stopPropagation 处理；到达容器说明落在空白区，即移动到工作区根目录
    const types = e.dataTransfer.types
    if (!types.includes('application/x-mtbot-file') && !types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    rootDropRef.current?.classList.add(styles['tree--dropTarget']!)
  }, [])

  const handleRootDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget === e.target) rootDropRef.current?.classList.remove(styles['tree--dropTarget']!)
  }, [])

  const handleRootDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    rootDropRef.current?.classList.remove(styles['tree--dropTarget']!)
    const raw = e.dataTransfer.getData('application/x-mtbot-file')
    if (!raw) return
    try {
      const ref = JSON.parse(raw) as { absolutePath?: string }
      if (ref.absolutePath) void handleDropMove(ref.absolutePath, rootPath)
    } catch (err) {
      console.error('[FileTree] 解析拖入文件失败:', err)
    }
  }, [handleDropMove, rootPath])

  return (
    <div
      ref={rootDropRef}
      className={styles.tree}
      onContextMenu={handleTreeContextMenu}
      onDragOver={handleRootDragOver}
      onDragLeave={handleRootDragLeave}
      onDrop={handleRootDrop}
    >
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
          rootPath={rootNorm}
          isExpanded={expandedDirs.has(normPath(item.path))}
          isSelected={selectedNorm === normPath(item.path)}
          isLoading={loadingDirs.has(normPath(item.path))}
          children={dirContents.get(normPath(item.path)) ?? []}
          expandedDirs={expandedDirs}
          dirContents={dirContents}
          loadingDirs={loadingDirs}
          selectedPath={selectedNorm}
          gitMap={gitMap}
          onToggle={handleToggle}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
          onMoreClick={onMoreClick}
          onDropMove={handleDropMove}
        />
      ))}
    </div>
  )
}
