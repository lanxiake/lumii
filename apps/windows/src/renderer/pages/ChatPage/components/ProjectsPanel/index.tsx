/**
 * ProjectsPanel — 工作台的「项目」页（单栏）
 *
 * 跨项目视角：有哪些挂载的项目、各自的分支/领先落后/增删改、哪个是活动项目，
 * 以及新建 / 打开 / 移除。项目内的目录树归「工作区文件」页。
 *
 * 复用文件面板顶部那套列表（`ProjectsSection`）：两处同一份数据、同一套弹窗，
 * 不另写一个项目管理器。
 */

import React, { useCallback } from 'react'
import { FolderGit2 } from 'lucide-react'
import { useCodingDevProjects, type UseCodingDevProjectsResult } from '../../../../hooks/business/useCodingDevProjects'
import { useWorkspace } from '../../../../hooks/business/useWorkspace'
import { ProjectsSection } from '../WorkspaceFilePanel/ProjectsSection'
import styles from './ProjectsPanel.module.css'

export interface ProjectsPanelProps {
  /** 「浏览这个项目的文件」：切到工作区文件页 */
  onBrowseFiles: () => void
}

export const ProjectsPanel: React.FC<ProjectsPanelProps> = ({ onBrowseFiles }) => {
  const api: UseCodingDevProjectsResult = useCodingDevProjects()
  const { workspaceDir } = useWorkspace()

  /** 选中项目 = 设为活动；文件页重挂载时读到的就是它 */
  const handleSelect = useCallback(
    async (name: string) => {
      await api.setActive(name)
      onBrowseFiles()
    },
    [api, onBrowseFiles],
  )

  return (
    <div className={styles.root}>
      {!workspaceDir ? (
        <div className={styles.empty}>
          <FolderGit2 size={28} strokeWidth={1.4} />
          <p className={styles.emptyTitle}>还没有工作区</p>
          <p className={styles.emptyHint}>先让 Agent 建一个工作区，项目才有地方落。</p>
        </div>
      ) : (
        <>
          <p className={styles.intro}>
            挂载在 <code>{workspaceDir}/projects</code> 下的项目。点一行设为活动项目并打开它的文件。
          </p>
          <ProjectsSection
            api={api}
            fullPage
            onLocateProject={(name) => void handleSelect(name)}
            onTreeRefresh={() => void api.reload()}
          />
        </>
      )}
    </div>
  )
}
