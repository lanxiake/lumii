import { useCallback, useEffect, useRef, useState } from 'react'
import type { ViewType } from '../../../components/Router'
import type { WorkbenchPreset, WorkbenchView } from '../components/WorkspaceWorkbench'
import { hashWorkspaceDir } from '../components/WorkspaceWorkbench/layout'
import { useWorkspaceVcs } from '../../../hooks/business/useWorkspaceVcs'
import { useWorkspace } from '../../../hooks/business/useWorkspace'

type LocateFileTarget = {
  path: string
  token: number
  preview?: boolean
  fileName?: string
}

/** 工作台状态：视图 / 只看产出 / 宽度档位 / 当前选中产物 */
export interface WorkbenchState {
  open: boolean
  view: WorkbenchView
  /** 只看产出：workspace 视图内的呈现密度开关 */
  onlyArtifacts: boolean
  preset: WorkbenchPreset
  /** 手动拖拽后的像素宽度；preset!=='custom' 时由 preset 推导 */
  customWidth?: number
  /** main 当前打开的产物（工作区相对路径；工作区外的文件存绝对路径） */
  selectedPath?: string
}

const STORAGE_PREFIX = 'lumii.workbench.v2.'

type PersistedWorkbench = Pick<WorkbenchState, 'view' | 'onlyArtifacts' | 'preset' | 'customWidth'>

export { hashWorkspaceDir }

function storageKey(workspaceDir: string): string {
  return `${STORAGE_PREFIX}${hashWorkspaceDir(workspaceDir)}`
}

function loadPersisted(workspaceDir: string): PersistedWorkbench | null {
  try {
    const raw = localStorage.getItem(storageKey(workspaceDir))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedWorkbench>
    if (parsed.view !== 'workspace' && parsed.view !== 'vcs') return null
    return {
      view: parsed.view,
      onlyArtifacts: parsed.onlyArtifacts !== false,
      preset:
        parsed.preset === 'wide' || parsed.preset === 'full' || parsed.preset === 'custom'
          ? parsed.preset
          : 'half',
      ...(typeof parsed.customWidth === 'number' ? { customWidth: parsed.customWidth } : {}),
    }
  } catch {
    return null
  }
}

function savePersisted(workspaceDir: string, state: WorkbenchState): void {
  try {
    const persisted: PersistedWorkbench = {
      view: state.view,
      onlyArtifacts: state.onlyArtifacts,
      preset: state.preset,
      ...(state.customWidth !== undefined ? { customWidth: state.customWidth } : {}),
    }
    localStorage.setItem(storageKey(workspaceDir), JSON.stringify(persisted))
  } catch {
    // localStorage 不可用时静默降级到内存态
  }
}

const INITIAL: WorkbenchState = {
  open: false,
  view: 'workspace',
  onlyArtifacts: true,
  preset: 'half',
}

/** Owns workbench visibility, view state, width preset, and file reveal state. */
export function useWorkspacePanels(activeView: ViewType | undefined) {
  const [workbench, setWorkbench] = useState<WorkbenchState>(INITIAL)
  const [locateFileTarget, setLocateFileTarget] = useState<LocateFileTarget | null>(null)
  const { uncommittedDiff, refresh: refreshVcs } = useWorkspaceVcs()
  const { workspaceDir, toAbsolutePath, toRelativePath } = useWorkspace()
  const locateTokenRef = useRef(0)
  /** 只在首次拿到工作区路径时读回持久化，避免后续覆盖用户当前操作 */
  const hydratedRef = useRef(false)

  useEffect(() => {
    if (!workspaceDir || hydratedRef.current) return
    hydratedRef.current = true
    const persisted = loadPersisted(workspaceDir)
    if (persisted) setWorkbench((previous) => ({ ...previous, ...persisted }))
  }, [workspaceDir])

  useEffect(() => {
    if (!workspaceDir || !hydratedRef.current) return
    savePersisted(workspaceDir, workbench)
  }, [workspaceDir, workbench])

  const closeWorkbench = useCallback(() => {
    setWorkbench((previous) => ({ ...previous, open: false }))
  }, [])

  const selectWorkbenchView = useCallback((view: WorkbenchView) => {
    setWorkbench((previous) => ({ ...previous, view, open: true }))
  }, [])

  const toggleWorkbench = useCallback(() => {
    setWorkbench((previous) =>
      previous.open
        ? { ...previous, open: false }
        : { ...previous, open: true, view: 'workspace' },
    )
  }, [])

  const setOnlyArtifacts = useCallback((onlyArtifacts: boolean) => {
    setWorkbench((previous) => ({ ...previous, onlyArtifacts, open: true, view: 'workspace' }))
  }, [])

  const setPreset = useCallback((preset: WorkbenchPreset, customWidth?: number) => {
    setWorkbench((previous) => ({
      ...previous,
      preset,
      ...(preset === 'custom' && customWidth !== undefined ? { customWidth } : {}),
    }))
  }, [])

  const selectPath = useCallback((selectedPath: string | undefined) => {
    setWorkbench((previous) => ({ ...previous, selectedPath, open: true }))
  }, [])

  const handleReviewTurnFileChange = useCallback((relativePath: string, status: 'added' | 'modified' | 'deleted') => {
    locateTokenRef.current += 1
    setWorkbench((previous) => ({
      ...previous,
      open: true,
      view: 'workspace',
      onlyArtifacts: false,
      selectedPath: undefined,
    }))
    setLocateFileTarget({
      path: toAbsolutePath(relativePath),
      token: locateTokenRef.current,
      preview: status !== 'deleted',
      fileName: relativePath.split('/').pop() ?? relativePath,
    })
  }, [toAbsolutePath])

  const revealInFiles = useCallback((relativePath: string) => {
    locateTokenRef.current += 1
    setWorkbench((previous) => ({
      ...previous,
      open: true,
      view: 'workspace',
      onlyArtifacts: false,
      selectedPath: undefined,
    }))
    setLocateFileTarget({
      path: toAbsolutePath(relativePath),
      token: locateTokenRef.current,
    })
  }, [toAbsolutePath])

  const locateAbsoluteFile = useCallback((absolutePath: string) => {
    locateTokenRef.current += 1
    setWorkbench((previous) => ({
      ...previous,
      open: true,
      view: 'workspace',
      onlyArtifacts: false,
    }))
    setLocateFileTarget({ path: absolutePath, token: locateTokenRef.current })
  }, [])

  /**
   * 在 main 区打开一份稿件（`app_panel` 的 doc 模式 / 文件面板右键菜单 / 产物卡）。
   *
   * 文档不再是一个 Tab：它只是 main 的一种预览内容（设计 §4）。
   * 工作区外的文件保留绝对路径（`toAbsolutePath` 会原样透传）。
   */
  const openDoc = useCallback((absolutePath: string) => {
    const normalizedRoot = (workspaceDir ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
    const normalized = absolutePath.replace(/\\/g, '/')
    // Windows 路径大小写不敏感；按小写比较，避免 E:\WS 与 e:/ws 被当成工作区外
    const inside =
      normalizedRoot &&
      normalized.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}/`)
    const selectedPath = inside ? normalized.slice(normalizedRoot.length + 1) : normalized
    setWorkbench((previous) => ({
      ...previous,
      open: true,
      view: 'workspace',
      onlyArtifacts: true,
      selectedPath,
    }))
  }, [workspaceDir, toRelativePath])

  useEffect(() => {
    if (activeView && activeView !== 'chat') closeWorkbench()
  }, [activeView, closeWorkbench])

  return {
    workbench,
    locateFileTarget,
    uncommittedDiff,
    refreshVcs,
    toggleWorkbench,
    handleReviewTurnFileChange,
    closeWorkbench,
    selectWorkbenchView,
    setOnlyArtifacts,
    setPreset,
    selectPath,
    revealInFiles,
    locateAbsoluteFile,
    openDoc,
    workspaceDir,
    toAbsolutePath,
    toRelativePath,
  }
}
