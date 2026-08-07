/**
 * FileSearchBar — 工作空间文件搜索输入框
 *
 * - 支持按文件名模糊搜索（正则/通配符，由主进程 file:search 处理）
 * - 支持按文件类型过滤（all / doc / image / code / video / audio / archive）
 * - 搜索结果以扁平列表形式展示，点击结果触发 onSelectResult
 *
 * 搜索路径锚定在 rootPath（workspace 根目录），递归子目录。
 * 防抖 250ms 避免输入抖动造成过多 IPC 请求。
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import clsx from 'clsx'
import type { FileItem } from '../../../../hooks/business/useFiles/useFiles.types'
import styles from './FileSearchBar.module.css'

/** 按类型分组的扩展名集合（与 file-attachment-strategy 保持一致） */
const TYPE_EXT_GROUPS: Record<string, readonly string[]> = {
  all: [],
  doc: ['pdf', 'doc', 'docx', 'rtf', 'odt', 'xls', 'xlsx', 'ppt', 'pptx', 'md', 'txt'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tiff', 'heic', 'avif'],
  code: [
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt',
    'c', 'cpp', 'h', 'hpp', 'cs', 'swift', 'html', 'css', 'scss', 'json', 'yaml', 'yml',
    'toml', 'xml', 'vue', 'svelte', 'sh', 'bash', 'sql', 'graphql',
  ],
  video: ['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'flv', 'wmv'],
  audio: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'opus'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'],
}

type FileTypeFilter = keyof typeof TYPE_EXT_GROUPS

const TYPE_LABELS: Record<FileTypeFilter, string> = {
  all: '全部',
  doc: '文档',
  image: '图片',
  code: '代码',
  video: '视频',
  audio: '音频',
  archive: '压缩包',
}

// ── SVG 图标 ──
const IconSearch: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
)

const IconX: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
)

const IconFilter: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
  </svg>
)

function parseRawItem(raw: {
  name: string; path: string; isDirectory: boolean
  size: number; modifiedAt: string | Date; createdAt: string | Date
  extension?: string
}): FileItem {
  const ext = raw.isDirectory ? undefined : (raw.extension ?? getExtension(raw.name))
  return {
    name: raw.name,
    path: raw.path,
    isDirectory: raw.isDirectory,
    size: raw.size,
    modifiedAt: raw.modifiedAt instanceof Date ? raw.modifiedAt : new Date(raw.modifiedAt),
    createdAt: raw.createdAt instanceof Date ? raw.createdAt : new Date(raw.createdAt),
    extension: typeof ext === 'string' ? ext.replace(/^\./, '').toLowerCase() : ext,
    icon: '',
  }
}

function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.')
  if (lastDot === -1 || lastDot === 0) return ''
  return filename.slice(lastDot + 1).toLowerCase()
}

/** 绝对路径转 workspace 相对路径（用于拖入输入框作 @引用） */
function toRelative(rootPath: string, absPath: string): string {
  const root = rootPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const abs = absPath.replace(/\\/g, '/')
  return abs.startsWith(root + '/') ? abs.slice(root.length + 1) : abs
}

/**
 * 将用户输入转为主进程 file:search 可识别的正则模式：
 * - 空白串：返回 null（不搜索）
 * - 已包含正则特殊字符：原样当成正则
 * - 以 `.` 开头（如 `.md` / `.tsx`）：作为文件后缀，锚定结尾精确匹配
 * - 普通文本：对特殊字符转义后作 case-insensitive 子串模糊匹配（支持文件全名）
 */
function buildSearchPattern(query: string): string | null {
  const trimmed = query.trim()
  if (!trimmed) return null
  // 若用户明确输入通配符 `*` 或 `?`，转为正则
  if (/[*?]/.test(trimmed)) {
    return trimmed.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  }
  // 后缀搜索：以 . 开头且只含一个 . 的纯扩展名（.md / .tsx）→ 锚定结尾
  if (trimmed.startsWith('.') && trimmed.length > 1 && !trimmed.slice(1).includes('.')) {
    const ext = trimmed.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return `\\.${ext}$`
  }
  // 否则作为 case-insensitive 子串模糊匹配（覆盖文件全名）
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return escaped
}

/**
 * 按类型构造「仅匹配该类型后缀」的正则，服务端先按扩展名筛选，避免 maxResults 被目录占满。
 */
function buildTypeExtPattern(type: FileTypeFilter): string | null {
  if (type === 'all') return null
  const exts = TYPE_EXT_GROUPS[type]
  if (!exts || exts.length === 0) return null
  const escaped = exts.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  return `\\.(?:${escaped})$`
}

export interface FileSearchBarProps {
  /** 搜索根路径（workspace 根） */
  rootPath: string
  /** 选中搜索结果时触发（预览 / 定位） */
  onSelectResult: (item: FileItem) => void
  /** 搜索状态变化（用于父组件切换显示树 / 搜索结果） */
  onSearchStateChange?: (isSearching: boolean) => void
  /** 右键搜索结果：复用与树节点一致的上下文菜单（复制路径/重命名/打开所在位置等） */
  onContextMenu?: (e: React.MouseEvent, item: FileItem) => void
}

export const FileSearchBar: React.FC<FileSearchBarProps> = ({
  rootPath, onSelectResult, onSearchStateChange, onContextMenu,
}) => {
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<FileTypeFilter>('all')
  const [results, setResults] = useState<FileItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestIdRef = useRef(0)

  const isSearching = query.trim().length > 0 || typeFilter !== 'all'

  // 通知父组件搜索态变化
  useEffect(() => {
    onSearchStateChange?.(isSearching)
  }, [isSearching, onSearchStateChange])

  // 防抖搜索：类型筛选时用后缀正则在服务端过滤，避免 maxResults 被目录占满导致结果为空
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    const userPattern = buildSearchPattern(query)
    const typePattern = buildTypeExtPattern(typeFilter)

    // 有类型筛选 → 优先用后缀正则；仅关键词 → 用关键词；两者皆无 → 不搜索
    const pattern = typePattern ?? userPattern
    if (!pattern || !rootPath) {
      setResults([])
      setLoading(false)
      setError(null)
      return
    }
    setLoading(true)
    debounceTimer.current = setTimeout(async () => {
      const myRequestId = ++requestIdRef.current
      try {
        const raw = await window.electronAPI.file.search(rootPath, pattern, {
          recursive: true,
          maxResults: 500,
        }) as Array<{
          name: string; path: string; isDirectory: boolean
          size: number; modifiedAt: string | Date; createdAt: string | Date
          extension?: string
        }>
        if (myRequestId !== requestIdRef.current) return
        let parsed = raw.map(parseRawItem).filter((f) => !f.isDirectory)

        if (typeFilter !== 'all') {
          const allowed = TYPE_EXT_GROUPS[typeFilter]
          parsed = parsed.filter((f) => allowed.includes((f.extension ?? '').toLowerCase()))
        }

        // 同时有关键词与类型时：类型已在服务端筛，再按文件名做客户端子串过滤
        if (typePattern && userPattern && query.trim()) {
          const q = query.trim().toLowerCase()
          parsed = parsed.filter((f) => f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
        }

        parsed.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
        setResults(parsed)
        setError(null)
      } catch (err) {
        if (myRequestId !== requestIdRef.current) return
        console.error('[FileSearchBar] 搜索失败:', err)
        setError(err instanceof Error ? err.message : '搜索失败')
        setResults([])
      } finally {
        if (myRequestId === requestIdRef.current) setLoading(false)
      }
    }, 250)
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
    }
  }, [query, typeFilter, rootPath])

  const handleClear = useCallback(() => {
    setQuery('')
    setResults([])
    inputRef.current?.focus()
  }, [])

  const resultList = useMemo(() => (
    <div className={styles.results}>
      {loading && (
        <div className={styles.statusRow}>搜索中…</div>
      )}
      {error && (
        <div className={clsx(styles.statusRow, styles.error)}>{error}</div>
      )}
      {!loading && !error && isSearching && results.length === 0 && (
        <div className={styles.statusRow}>未找到匹配项</div>
      )}
      {!loading && !error && results.map((item) => (
        <button
          key={item.path}
          type="button"
          className={styles.resultItem}
          onClick={() => onSelectResult(item)}
          onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(e, item) } : undefined}
          draggable={!item.isDirectory}
          onDragStart={(e) => {
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
          }}
          title={item.path}
        >
          <span className={styles.resultName}>
            {item.name}
            {item.isDirectory && <span className={styles.resultDirBadge}>/</span>}
          </span>
          <span className={styles.resultPath}>{item.path}</span>
        </button>
      ))}
    </div>
  ), [loading, error, results, isSearching, onSelectResult, onContextMenu, rootPath])

  return (
    <div className={clsx(styles.container, isSearching && styles['container--searching'])}>
      {/* 搜索输入栏 */}
      <div className={styles.inputRow}>
        <span className={styles.searchIcon}><IconSearch size={13} /></span>
        <input
          ref={inputRef}
          type="text"
          className={styles.input}
          placeholder="搜索文件名 / 后缀（如 .md）/ 通配符 *"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') handleClear()
          }}
        />
        {query && (
          <button
            type="button"
            className={styles.clearBtn}
            onClick={handleClear}
            title="清除搜索"
          >
            <IconX size={12} />
          </button>
        )}
      </div>

      {/* 类型过滤标签 */}
      <div className={styles.filterRow}>
        <span className={styles.filterIcon}><IconFilter /></span>
        {(Object.keys(TYPE_LABELS) as FileTypeFilter[]).map((t) => (
          <button
            key={t}
            type="button"
            className={clsx(styles.filterChip, typeFilter === t && styles['filterChip--active'])}
            onClick={() => setTypeFilter(t)}
          >
            {TYPE_LABELS[t]}
          </button>
        ))}
      </div>

      {/* 搜索结果（仅搜索时显示） */}
      {isSearching && resultList}
    </div>
  )
}
