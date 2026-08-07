/**
 * 工作区文件抽屉顶部的 ACP 项目列表：新建 / 打开 / 切换活动 / 移除 / 折叠。
 */
import React, { useCallback, useState } from 'react'
import clsx from 'clsx'
import type { UseCodingDevProjectsResult } from '../../../../hooks/business/useCodingDevProjects'
import { useCodingDevProjectModals } from '../../../../hooks/business/useCodingDevProjects'
import styles from './ProjectsSection.module.css'

const COLLAPSE_KEY = 'lumii.workspace.projectsCollapsed'

type Props = {
  api: UseCodingDevProjectsResult
  /** 定位文件树到 workspace/projects/<name>，并刷新树 */
  onLocateProject: (name: string) => void
  /** 项目增删后刷新文件树（不强制定位） */
  onTreeRefresh: () => void
}

/**
 * 渲染 Projects 列表区（类似 Cursor Workspaces，不含提交历史）。
 */
export const ProjectsSection: React.FC<Props> = ({ api, onLocateProject, onTreeRefresh }) => {
  const { projects, activeProject, error, setActive } = api
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1'
    } catch {
      return false
    }
  })

  const onProjectReady = useCallback(async (project: { name: string }) => {
    onTreeRefresh()
    onLocateProject(project.name)
  }, [onTreeRefresh, onLocateProject])

  const onRemoved = useCallback(async () => {
    onTreeRefresh()
  }, [onTreeRefresh])

  const { beginCreate, beginOpen, beginRemove, modals } = useCodingDevProjectModals({
    api,
    onProjectReady,
    onRemoved,
  })

  /** 折叠/展开并持久化偏好 */
  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0')
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])

  /**
   * 单击项目：设为活动并定位文件树。
   */
  const handleSelect = async (name: string) => {
    await setActive(name)
    onLocateProject(name)
  }

  const activeLabel = activeProject || '无活动项目'

  return (
    <section className={styles.root} aria-label="项目">
      <header className={styles.header}>
        <button
          type="button"
          className={styles.collapseBtn}
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          title={collapsed ? '展开项目列表' : '收起项目列表'}
        >
          <span className={clsx(styles.chevron, !collapsed && styles.chevronOpen)}>▾</span>
          <span className={styles.title}>项目</span>
        </button>
        {collapsed && (
          <span className={styles.activeSummary} title={activeLabel}>
            {activeProject ? `活动: ${activeProject}` : '无活动'}
          </span>
        )}
        <div className={styles.actions}>
          <button type="button" className={styles.iconBtn} title="新建项目" onClick={beginCreate}>
            +
          </button>
          <button type="button" className={styles.iconBtn} title="打开已有项目" onClick={() => void beginOpen()}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              <line x1="12" y1="11" x2="12" y2="17" />
              <line x1="9" y1="14" x2="15" y2="14" />
            </svg>
          </button>
        </div>
      </header>
      {error && <div className={styles.error}>{error}</div>}
      {!collapsed && (
        <ul className={styles.list}>
          {projects.length === 0 && (
            <li className={styles.empty}>暂无项目。新建或打开后会出现在 projects/ 下。</li>
          )}
          {projects.map((p) => {
            const isActive = p.name === activeProject
            return (
              <li key={p.name} className={isActive ? styles.itemActive : styles.item}>
                <button
                  type="button"
                  className={styles.itemMain}
                  onClick={() => void handleSelect(p.name)}
                  title={isActive ? `当前活动 · ${p.realPath}` : `设为活动并定位 · ${p.realPath}`}
                >
                  <span className={styles.folderIcon} aria-hidden>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                  </span>
                  <span className={styles.name}>{p.name}</span>
                  {p.isExternal && <span className={styles.badge}>链接</span>}
                  {isActive && <span className={styles.activeDot}>活动</span>}
                </button>
                {!isActive && (
                  <button
                    type="button"
                    className={styles.setActive}
                    title="设为活动项目"
                    onClick={() => void handleSelect(p.name)}
                  >
                    设为活动
                  </button>
                )}
                <button
                  type="button"
                  className={styles.remove}
                  title="移除"
                  onClick={() => beginRemove(p.name)}
                >
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {modals}
    </section>
  )
}
