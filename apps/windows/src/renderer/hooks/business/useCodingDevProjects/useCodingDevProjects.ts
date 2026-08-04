/**
 * ACP 项目管理：列表、新建、打开已有、设活动、移除。
 * 供设置页与 WorkspaceFilePanel 侧栏共用。
 *
 * 注意：Electron 渲染进程不支持 window.prompt/confirm，名称与确认由 UI 弹窗传入。
 */
import { useCallback, useEffect, useState } from 'react'

export type CodingDevProject = {
  name: string
  realPath: string
  isExternal: boolean
}

export type UseCodingDevProjectsResult = {
  projects: CodingDevProject[]
  activeProject: string | undefined
  loading: boolean
  error: string | null
  reload: () => Promise<void>
  /** 按名称新建项目（名称由 UI 弹窗采集） */
  createProject: (name: string) => Promise<CodingDevProject | null>
  /**
   * 选择已有目录（原生文件夹对话框），不创建项目。
   * 返回路径与建议名，供 UI 再弹名称输入框。
   */
  pickExistingDirectory: () => Promise<{ path: string; defaultName: string } | null>
  /** 以名称 + 目标路径挂载已有项目 */
  openProject: (name: string, targetPath: string) => Promise<CodingDevProject | null>
  setActive: (name: string) => Promise<void>
  /** 直接移除（确认由 UI ConfirmModal 完成） */
  remove: (name: string) => Promise<void>
}

/**
 * 从项目列表中按活动名查找条目。
 */
function findByActive(
  projects: CodingDevProject[],
  activeProject: string | undefined,
): CodingDevProject | null {
  if (!activeProject) return null
  return projects.find((p) => p.name === activeProject) ?? null
}

/**
 * 生成移除确认文案（外部仅删链接，内部保留磁盘目录）。
 */
export function getRemoveProjectHint(project: CodingDevProject | undefined, name: string): string {
  if (project?.isExternal) {
    return `移除项目「${name}」？仅删除挂载链接，不影响真实目录。`
  }
  return `移除项目「${name}」？磁盘目录 workspace/projects/${name} 会保留。`
}

/**
 * 管理 ACP 项目列表与活动项目状态。
 */
export function useCodingDevProjects(): UseCodingDevProjectsResult {
  const [projects, setProjects] = useState<CodingDevProject[]>([])
  const [activeProject, setActiveProject] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const res = await window.electronAPI.app.listCodingDevProjects()
      setProjects(res.projects)
      setActiveProject(res.activeProject)
      setError(null)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const createProject = useCallback(async (name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return null
    try {
      const res = await window.electronAPI.app.createCodingDevProject(trimmed)
      setProjects(res.projects)
      setActiveProject(res.activeProject)
      setError(null)
      return findByActive(res.projects, res.activeProject)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    }
  }, [])

  const pickExistingDirectory = useCallback(async () => {
    const { canceled, filePaths } = await window.electronAPI.dialog.showOpenDialog({
      title: '选择要挂载的已有项目目录',
      properties: ['openDirectory'],
    })
    if (canceled || !filePaths?.[0]) return null
    const path = filePaths[0]
    const defaultName = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '项目'
    return { path, defaultName }
  }, [])

  const openProject = useCallback(async (name: string, targetPath: string) => {
    const trimmed = name.trim()
    if (!trimmed) return null
    try {
      const res = await window.electronAPI.app.openCodingDevProject(trimmed, targetPath)
      setProjects(res.projects)
      setActiveProject(res.activeProject)
      setError(null)
      return findByActive(res.projects, res.activeProject)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    }
  }, [])

  const setActive = useCallback(async (name: string) => {
    try {
      const res = await window.electronAPI.app.setCodingDevActiveProject(name)
      setActiveProject(res.activeProject)
      setError(null)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const remove = useCallback(async (name: string) => {
    try {
      const res = await window.electronAPI.app.removeCodingDevProject(name)
      setProjects(res.projects)
      setActiveProject(res.activeProject)
      setError(null)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  return {
    projects,
    activeProject,
    loading,
    error,
    reload,
    createProject,
    pickExistingDirectory,
    openProject,
    setActive,
    remove,
  }
}
