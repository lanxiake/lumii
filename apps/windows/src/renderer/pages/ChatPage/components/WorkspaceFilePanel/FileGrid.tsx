/**
 * FileGrid — 工作区文件的平铺卡片视图（目录平铺）
 *
 * 树解决的是「我在哪、怎么走到这」；网格解决的是「这个目录里有什么」——
 * 图片一眼看到缩略图，其它文件用扩展名方块。两者切换不丢当前目录。
 *
 * 只渲染**当前目录**一层：点文件夹进下一层，顶部面包屑「‹ 返回」回上一层。
 * 不做无限递归铺开（那会把 node_modules 也铺成几千张卡）。
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { ChevronLeft, Folder } from 'lucide-react'
import { listDirectory, type RawFileEntry } from '../../../../services/file-service'
import { mediaUrl, isImagePath } from '../WorkspaceArtifactsPanel/ledger'
import styles from './FileGrid.module.css'

export interface FileGridProps {
  /** 根目录（工作区） */
  rootPath: string
  /** 当前目录绝对路径；不传 = 根目录 */
  dirPath?: string
  /** 外部定位到某个文件（会切到它所在目录并高亮） */
  selectedPath?: string | null
  onOpenFile: (absolutePath: string) => void
  onEnterDir?: (absolutePath: string) => void
  /** 右键菜单（与树共用同一套动作） */
  onContextMenu?: (event: React.MouseEvent, item: RawFileEntry) => void
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

function parentOf(dir: string, root: string): string | null {
  const d = normalize(dir)
  const r = normalize(root)
  if (d === r) return null
  const idx = d.lastIndexOf('/')
  if (idx <= 0) return null
  const parent = d.slice(0, idx)
  return parent.length < r.length ? r : parent
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function extLabel(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : '—'
}

export const FileGrid: React.FC<FileGridProps> = ({
  rootPath,
  dirPath,
  selectedPath,
  onOpenFile,
  onEnterDir,
  onContextMenu,
}) => {
  const [current, setCurrent] = useState(() => normalize(dirPath ?? rootPath))
  const [entries, setEntries] = useState<RawFileEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // 外部切换根目录（换工作区）时回到根
  useEffect(() => {
    setCurrent(normalize(dirPath ?? rootPath))
  }, [dirPath, rootPath])

  // 外部定位到某个文件：切到它所在目录
  useEffect(() => {
    if (!selectedPath) return
    const normalized = normalize(selectedPath)
    const currentDir = normalize(current)
    if (normalized.startsWith(`${currentDir}/`)) return
    const idx = normalized.lastIndexOf('/')
    if (idx > 0) setCurrent(normalized.slice(0, idx))
  }, [selectedPath]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void listDirectory(current)
      .then((list) => {
        if (cancelled) return
        // 目录在前、再按名字；与树的行序一致
        setEntries(
          [...list].sort((a, b) =>
            a.isDirectory === b.isDirectory
              ? a.name.localeCompare(b.name)
              : a.isDirectory
                ? -1
                : 1,
          ),
        )
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [current])

  const parent = useMemo(() => parentOf(current, rootPath), [current, rootPath])
  const selectedNorm = selectedPath ? normalize(selectedPath) : null

  const goUp = useCallback(() => {
    if (parent) setCurrent(parent)
  }, [parent])

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <button
          type="button"
          className={styles.backBtn}
          onClick={goUp}
          disabled={!parent}
          title={parent ? '返回上一级' : '已在工作区根目录'}
          aria-label="返回上一级"
        >
          <ChevronLeft size={13} strokeWidth={2} />
        </button>
        <span className={styles.crumb} title={current}>
          {current.slice(normalize(rootPath).length).replace(/^\//, '') || '工作区根目录'}
        </span>
        <span className={styles.count}>{entries.length} 项</span>
      </div>

      {error ? (
        <div className={styles.state}>读取失败：{error}</div>
      ) : loading && entries.length === 0 ? (
        <div className={styles.state}>正在读取…</div>
      ) : entries.length === 0 ? (
        <div className={styles.state}>这个目录是空的。</div>
      ) : (
        <div className={styles.grid}>
          {entries.map((entry) => {
            const isDir = entry.isDirectory
            const isImage = !isDir && isImagePath(entry.path)
            const isSelected = selectedNorm === normalize(entry.path)
            return (
              <button
                key={entry.path}
                type="button"
                className={clsx(styles.cell, isSelected && styles.cellSelected)}
                title={entry.path}
                onClick={() => {
                  if (isDir) {
                    if (onEnterDir) onEnterDir(entry.path)
                    else setCurrent(normalize(entry.path))
                  } else {
                    onOpenFile(entry.path)
                  }
                }}
                onContextMenu={(event) => {
                  if (!onContextMenu) return
                  event.preventDefault()
                  onContextMenu(event, entry)
                }}
              >
                <span className={styles.preview}>
                  {isDir ? (
                    <Folder size={30} strokeWidth={1.4} className={styles.folderIcon} />
                  ) : isImage ? (
                    <img
                      src={mediaUrl(entry.path)}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className={styles.thumb}
                      onError={(event) => {
                        // 读不出就退回扩展名方块，别在格子里留个破图标
                        event.currentTarget.style.display = 'none'
                      }}
                    />
                  ) : (
                    <span className={styles.extBadge}>{extLabel(entry.name)}</span>
                  )}
                </span>
                <span className={styles.name}>{entry.name}</span>
                <span className={styles.meta}>{isDir ? '文件夹' : formatSize(entry.size)}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
