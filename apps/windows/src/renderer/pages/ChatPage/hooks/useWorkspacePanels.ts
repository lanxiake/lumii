import { useCallback, useEffect, useRef, useState } from 'react'
import type { ViewType } from '../../../components/Router'
import type { WorkbenchLayoutMode, WorkbenchTab } from '../components/WorkspaceWorkbench'
import { useWorkspaceVcs } from '../../../hooks/business/useWorkspaceVcs'
import { useWorkspace } from '../../../hooks/business/useWorkspace'

type LocateFileTarget = {
  path: string
  token: number
  preview?: boolean
  fileName?: string
}

/** Owns workbench visibility, panel layout, VCS refresh, and file reveal state. */
export function useWorkspacePanels(activeView: ViewType | undefined) {
  const [workbench, setWorkbench] = useState<{ open: boolean; tab: WorkbenchTab }>({ open: false, tab: 'files' })
  const [workbenchWidth, setWorkbenchWidth] = useState(0)
  const [workbenchResizing, setWorkbenchResizing] = useState(false)
  const [workbenchLayout, setWorkbenchLayout] = useState<WorkbenchLayoutMode>('default')
  const [locateFileTarget, setLocateFileTarget] = useState<LocateFileTarget | null>(null)
  /** 「文档」Tab 当前打开的稿件绝对路径；关闭工作台时保留（再打开回到上次那份） */
  const [docPath, setDocPath] = useState<string | null>(null)
  const { uncommittedDiff, refresh: refreshVcs } = useWorkspaceVcs()
  const { workspaceDir, toAbsolutePath } = useWorkspace()
  const locateTokenRef = useRef(0)

  const closeWorkbench = useCallback(() => {
    setWorkbench((previous) => ({ ...previous, open: false }))
  }, [])

  const selectWorkbenchTab = useCallback((tab: WorkbenchTab) => {
    setWorkbenchLayout('default')
    setWorkbench((previous) => ({ ...previous, tab, open: true }))
  }, [])

  const toggleFilesWorkbench = useCallback(() => {
    setWorkbenchLayout('default')
    setWorkbench((previous) => (
      previous.open && previous.tab === 'files'
        ? { ...previous, open: false }
        : { open: true, tab: 'files' }
    ))
  }, [])

  const handleReviewTurnFileChange = useCallback((relativePath: string, status: 'added' | 'modified' | 'deleted') => {
    locateTokenRef.current += 1
    setWorkbenchLayout('default')
    setWorkbench({ open: true, tab: 'files' })
    setLocateFileTarget({
      path: toAbsolutePath(relativePath),
      token: locateTokenRef.current,
      preview: status !== 'deleted',
      fileName: relativePath.split('/').pop() ?? relativePath,
    })
  }, [toAbsolutePath])

  const revealInFiles = useCallback((relativePath: string) => {
    const root = (workspaceDir ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
    locateTokenRef.current += 1
    setWorkbenchLayout('default')
    setWorkbench({ open: true, tab: 'files' })
    setLocateFileTarget({
      path: root ? `${root}/${relativePath.replace(/^\/+/, '')}` : relativePath,
      token: locateTokenRef.current,
    })
  }, [workspaceDir])

  const locateAbsoluteFile = useCallback((absolutePath: string) => {
    locateTokenRef.current += 1
    setWorkbench({ open: true, tab: 'files' })
    setLocateFileTarget({ path: absolutePath, token: locateTokenRef.current })
  }, [])

  /**
   * 在「文档」Tab 打开一份稿件（`app_panel` 的 doc 模式 / 文件面板右键菜单）。
   * 只设路径与 Tab，不判断文件类型——"该不该开面板"由 Agent 决定（设计 §3.1）。
   */
  const openDoc = useCallback((absolutePath: string) => {
    setWorkbenchLayout('default')
    setDocPath(absolutePath)
    setWorkbench({ open: true, tab: 'doc' })
  }, [])

  useEffect(() => {
    if (activeView && activeView !== 'chat') closeWorkbench()
  }, [activeView, closeWorkbench])

  return {
    workbench,
    workbenchWidth,
    workbenchResizing,
    workbenchLayout,
    locateFileTarget,
    docPath,
    uncommittedDiff,
    refreshVcs,
    toggleFilesWorkbench,
    handleReviewTurnFileChange,
    closeWorkbench,
    selectWorkbenchTab,
    setWorkbenchWidth,
    setWorkbenchResizing,
    setWorkbenchLayout,
    revealInFiles,
    locateAbsoluteFile,
    openDoc,
    workspaceDir,
    toAbsolutePath,
  }
}
