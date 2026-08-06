/**
 * ChangedFilesRail — 变更文件目录树导航
 *
 * - 仅文件可选中（文件夹只作路径结构展示，不可点选）
 * - 支持折叠/展开目录
 * - 支持整体显示/隐藏（由父级控制 visible）
 */

import React, { useMemo, useState } from 'react'
import clsx from 'clsx'
import { ChevronRight, ChevronDown, PanelRightClose, PanelRight } from 'lucide-react'
import type { VcsDiffItem } from '../../../../hooks/business/useWorkspaceVcs'
import styles from './ChangedFilesRail.module.css'

export interface ChangedFilesRailProps {
  files: VcsDiffItem[]
  activePath?: string
  onSelect: (filepath: string) => void
  /** 是否显示侧栏；false 时只渲染展开按钮 */
  visible: boolean
  onVisibleChange: (visible: boolean) => void
}

type TreeNode = {
  name: string
  path: string
  file?: VcsDiffItem
  children: TreeNode[]
}

/** 状态短标签 */
function statusLabel(status: VcsDiffItem['status']): string {
  if (status === 'added') return 'A'
  if (status === 'deleted') return 'D'
  return 'M'
}

/** 把扁平路径列表建成目录树（文件夹节点无 file 字段） */
function buildTree(files: VcsDiffItem[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [] }

  const ensureDir = (parts: string[]): TreeNode => {
    let cur = root
    let acc = ''
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part
      let next = cur.children.find((c) => c.name === part && !c.file)
      if (!next) {
        next = { name: part, path: acc, children: [] }
        cur.children.push(next)
      }
      cur = next
    }
    return cur
  }

  for (const f of files) {
    const norm = f.filepath.replace(/\\/g, '/')
    const parts = norm.split('/').filter(Boolean)
    if (parts.length === 0) continue
    const fileName = parts[parts.length - 1]
    const dirParts = parts.slice(0, -1)
    const parent = ensureDir(dirParts)
    parent.children.push({
      name: fileName,
      path: norm,
      file: f,
      children: [],
    })
  }

  const sortRec = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      const aDir = !a.file
      const bDir = !b.file
      if (aDir !== bDir) return aDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    nodes.forEach((n) => sortRec(n.children))
  }
  sortRec(root.children)
  return root.children
}

/**
 * 右侧变更文件目录树
 */
export const ChangedFilesRail: React.FC<ChangedFilesRailProps> = ({
  files,
  activePath,
  onSelect,
  visible,
  onVisibleChange,
}) => {
  const tree = useMemo(() => buildTree(files), [files])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const toggleDir = (path: string) => {
    setCollapsed((m) => ({ ...m, [path]: !m[path] }))
  }

  if (!visible) {
    return (
      <button
        type="button"
        className={styles.showBtn}
        onClick={() => onVisibleChange(true)}
        title="显示文件列表"
        aria-label="显示文件列表"
      >
        <PanelRight size={14} strokeWidth={1.8} />
      </button>
    )
  }

  const renderNodes = (nodes: TreeNode[], depth: number): React.ReactNode =>
    nodes.map((node) => {
      if (node.file) {
        const f = node.file
        return (
          <button
            key={node.path}
            type="button"
            className={clsx(
              styles.fileItem,
              activePath === f.filepath && styles.fileItemActive,
            )}
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => onSelect(f.filepath)}
            title={f.filepath}
          >
            <span className={clsx(styles.status, styles[`status_${f.status}`])}>
              {statusLabel(f.status)}
            </span>
            <span className={styles.name}>{node.name}</span>
            <span className={styles.stats}>
              <span className={styles.ins}>+{f.insertions}</span>
              <span className={styles.del}>−{f.deletions}</span>
            </span>
          </button>
        )
      }

      const isCollapsed = collapsed[node.path]
      return (
        <div key={node.path} className={styles.dirBlock}>
          <button
            type="button"
            className={styles.dirItem}
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => toggleDir(node.path)}
            title={node.path}
          >
            {isCollapsed ? (
              <ChevronRight size={12} strokeWidth={2} />
            ) : (
              <ChevronDown size={12} strokeWidth={2} />
            )}
            <span className={styles.dirName}>{node.name}</span>
          </button>
          {!isCollapsed && renderNodes(node.children, depth + 1)}
        </div>
      )
    })

  return (
    <aside className={styles.rail} aria-label="变更文件列表">
      <div className={styles.header}>
        <span className={styles.headerLabel}>{files.length} 个文件</span>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => onVisibleChange(false)}
          title="隐藏文件列表"
        >
          <PanelRightClose size={14} strokeWidth={1.8} />
        </button>
      </div>
      <div className={styles.list}>{renderNodes(tree, 0)}</div>
    </aside>
  )
}
