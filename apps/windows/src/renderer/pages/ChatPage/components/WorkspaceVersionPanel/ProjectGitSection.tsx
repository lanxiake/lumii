/**
 * ProjectGitSection — 工作空间版本面板中的项目汇总区
 *
 * 显示每个挂载项目的 git 状态汇总（新增/修改/删除数量）+ 可展开的文件列表
 */

import React, { useState, useCallback, useMemo } from 'react'
import clsx from 'clsx'
import { ChevronRight } from 'lucide-react'
import { useCodingDevProjects } from '../../../../hooks/business/useCodingDevProjects'
import { useProjectGitStatus } from '../../../../hooks/business/useProjectGitStatus'
import type { VcsDiffItem } from '../../../../hooks/business/useWorkspaceVcs'
import { DiffFileCard } from './DiffFileCard'
import styles from './ProjectGitSection.module.css'

interface ProjectGitSectionProps {
  /** 懒加载单文件 hunks 的回调（与工作区文件共用缓存逻辑） */
  onEnsureHunks?: (projectName: string, filepath: string) => void
  /** 撤销单文件回调 */
  onRevert?: (projectName: string, filepath: string) => void
  /** 在文件面板中定位 */
  onRevealInFiles?: (projectName: string, filepath: string) => void
  /** 当前缓存的 hunk 数据（key: `project:<name>:${filepath}`） */
  hunkCache?: Record<string, { item: VcsDiffItem; loading: boolean }>
}

/** 单个项目的汇总与文件列表 */
function ProjectGitItem({
  projectName,
  onEnsureHunks,
  onRevert,
  onRevealInFiles,
  hunkCache = {},
}: {
  projectName: string
  onEnsureHunks?: (filepath: string) => void
  onRevert?: (filepath: string) => void
  onRevealInFiles?: (filepath: string) => void
  hunkCache?: Record<string, { item: VcsDiffItem; loading: boolean }>
}) {
  const { status } = useProjectGitStatus(projectName)
  const [expanded, setExpanded] = useState(false)

  const stats = useMemo(() => {
    if (!status?.isRepo || !status.files) return { added: 0, modified: 0, deleted: 0, total: 0, totalIns: 0, totalDel: 0 }
    let added = 0
    let modified = 0
    let deleted = 0
    let totalIns = 0
    let totalDel = 0

    for (const f of status.files) {
      // 跳过忽略的文件
      if (f.index === '!' && f.worktree === '!') continue

      if (f.index === 'D' || f.worktree === 'D') {
        deleted++
      } else if (f.index === 'A' || (f.index === '?' && f.worktree === '?')) {
        added++
      } else if (f.index === 'M' || f.worktree === 'M') {
        modified++
      }

      totalIns += f.insertions ?? 0
      totalDel += f.deletions ?? 0
    }
    return { added, modified, deleted, total: added + modified + deleted, totalIns, totalDel }
  }, [status])

  // 转换为 VcsDiffItem 格式（带真实 insertions/deletions）
  const diffItems = useMemo<VcsDiffItem[]>(() => {
    if (!status?.files) return []
    return status.files
      .filter((f) => !(f.index === '!' && f.worktree === '!')) // 排除忽略的文件
      .map((f) => {
        let fileStatus: 'added' | 'modified' | 'deleted' = 'modified'
        if (f.index === 'A' || (f.index === '?' && f.worktree === '?')) fileStatus = 'added'
        else if (f.index === 'D' || f.worktree === 'D') fileStatus = 'deleted'
        return {
          filepath: f.path,
          status: fileStatus,
          insertions: f.insertions ?? 0,
          deletions: f.deletions ?? 0,
        }
      })
  }, [status])

  if (stats.total === 0) return null

  return (
    <div className={styles.projectItem}>
      <button
        type="button"
        className={styles.projectHeader}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <ChevronRight size={14} className={clsx(styles.chevron, expanded && styles.chevronExpanded)} />
        <span className={styles.projectName}>{projectName}</span>
        <span className={styles.projectStats}>
          {stats.totalIns > 0 && <span className={styles.statAdded}>+{stats.totalIns}</span>}
          {stats.totalDel > 0 && <span className={styles.statDeleted}>−{stats.totalDel}</span>}
          <span className={styles.statSummary}>
            ({stats.added > 0 && `${stats.added}新增 `}
            {stats.modified > 0 && `${stats.modified}修改 `}
            {stats.deleted > 0 && `${stats.deleted}删除`})
          </span>
        </span>
      </button>
      {expanded && (
        <div className={styles.projectFiles}>
          {diffItems.map((f) => {
            const key = `project:${projectName}:${f.filepath}`
            const cached = hunkCache[key]
            return (
              <div
                key={f.filepath}
                className={styles.fileCard}
                onMouseEnter={() => {
                  if (!cached && onEnsureHunks) onEnsureHunks(f.filepath)
                }}
              >
                <DiffFileCard
                  entry={cached?.item.hunks ? cached.item : f}
                  hunks={cached?.item.hunks}
                  loading={!cached || cached.loading}
                  truncated={cached?.item.truncated}
                  skipReason={cached?.item.skipReason}
                  onRevert={onRevert ? () => onRevert(f.filepath) : undefined}
                  onRevealInFiles={
                    onRevealInFiles
                      ? () => onRevealInFiles(f.filepath)
                      : undefined
                  }
                />
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export const ProjectGitSection: React.FC<ProjectGitSectionProps> = ({
  onEnsureHunks,
  onRevert,
  onRevealInFiles,
  hunkCache = {},
}) => {
  const { projects } = useCodingDevProjects()

  const handleEnsureHunks = useCallback(
    (projectName: string, filepath: string) => {
      onEnsureHunks?.(projectName, filepath)
    },
    [onEnsureHunks],
  )

  const handleRevert = useCallback(
    (projectName: string, filepath: string) => {
      onRevert?.(projectName, filepath)
    },
    [onRevert],
  )

  const handleRevealInFiles = useCallback(
    (projectName: string, filepath: string) => {
      onRevealInFiles?.(projectName, filepath)
    },
    [onRevealInFiles],
  )

  if (projects.length === 0) return null

  return (
    <div className={styles.root}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>项目变更</span>
      </div>
      {projects.map((p) => (
        <ProjectGitItem
          key={p.name}
          projectName={p.name}
          onEnsureHunks={(fp) => handleEnsureHunks(p.name, fp)}
          onRevert={(fp) => handleRevert(p.name, fp)}
          onRevealInFiles={(fp) => handleRevealInFiles(p.name, fp)}
          hunkCache={hunkCache}
        />
      ))}
    </div>
  )
}
