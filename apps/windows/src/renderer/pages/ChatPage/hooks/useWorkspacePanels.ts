import { useCallback, useEffect, useRef, useState } from 'react'
import type { ViewType } from '../../../components/Router'
import type { WorkbenchPreset, WorkbenchTabKind } from '../components/WorkspaceWorkbench'
import { closeTab, hashWorkspaceDir, openTab } from '../components/WorkspaceWorkbench/layout'
import { useWorkspaceVcs } from '../../../hooks/business/useWorkspaceVcs'
import { useWorkspace } from '../../../hooks/business/useWorkspace'

type LocateFileTarget = {
  path: string
  token: number
  preview?: boolean
  fileName?: string
}

/** 工作台状态：打开着的 tab / 当前 tab / 宽度档位 / 当前选中产物 */
export interface WorkbenchState {
  open: boolean
  /** 打开着的页，按 tab 条顺序 */
  tabs: readonly WorkbenchTabKind[]
  /** 当前页；tabs 为空时为 null（此时显示开始页） */
  activeTab: WorkbenchTabKind | null
  preset: WorkbenchPreset
  /** 手动拖拽后的像素宽度；preset!=='custom' 时由 preset 推导 */
  customWidth?: number
  /** main 当前打开的产物（工作区相对路径；工作区外的文件存绝对路径） */
  selectedPath?: string
  /** 跟随本轮最新成品（默认关；用户点卡/搜索即退出） */
  follow: boolean
}

const STORAGE_PREFIX = 'lumii.workbench.v3.'
/** 旧版（视图 + 只看产出开关）的 key：新 key 缺失时迁移一次 */
const LEGACY_STORAGE_PREFIX = 'lumii.workbench.v2.'
/** 每个会话「上次看工作台」的时间：工具栏角标与「上次查看之后」分隔行共用 */
const SEEN_PREFIX = 'lumii.workbench.seen.'

type PersistedWorkbench = Pick<
  WorkbenchState,
  'tabs' | 'activeTab' | 'preset' | 'customWidth' | 'follow'
>

export { hashWorkspaceDir }

const KNOWN_TABS: readonly WorkbenchTabKind[] = [
  'artifacts',
  'files',
  'project',
  'terminal',
  'vcs',
]

function isTabKind(value: unknown): value is WorkbenchTabKind {
  return typeof value === 'string' && (KNOWN_TABS as readonly string[]).includes(value)
}

function storageKey(workspaceDir: string): string {
  return STORAGE_PREFIX + hashWorkspaceDir(workspaceDir)
}

function legacyStorageKey(workspaceDir: string): string {
  return LEGACY_STORAGE_PREFIX + hashWorkspaceDir(workspaceDir)
}

function normalizePreset(value: unknown): WorkbenchPreset {
  return value === 'wide' || value === 'full' || value === 'custom' ? value : 'half'
}

/**
 * 从 pre-tab 版本迁移：`view=workspace + onlyArtifacts` 落到产物页，否则文件页。
 * 读不出来返回 null，让调用方走默认值。
 */
function migrateLegacy(workspaceDir: string): PersistedWorkbench | null {
  try {
    const raw = localStorage.getItem(legacyStorageKey(workspaceDir))
    if (!raw) return null
    const parsed = JSON.parse(raw) as {
      view?: unknown
      onlyArtifacts?: unknown
      preset?: unknown
      customWidth?: unknown
      follow?: unknown
    }
    const kind: WorkbenchTabKind =
      parsed.view === 'vcs' ? 'vcs' : parsed.onlyArtifacts === false ? 'files' : 'artifacts'
    return {
      tabs: [kind],
      activeTab: kind,
      preset: normalizePreset(parsed.preset),
      ...(typeof parsed.customWidth === 'number' ? { customWidth: parsed.customWidth } : {}),
      follow: parsed.follow === true,
    }
  } catch {
    return null
  }
}

function loadPersisted(workspaceDir: string): PersistedWorkbench | null {
  try {
    const raw = localStorage.getItem(storageKey(workspaceDir))
    if (!raw) return migrateLegacy(workspaceDir)
    const parsed = JSON.parse(raw) as Partial<PersistedWorkbench>
    const tabs = Array.isArray(parsed.tabs) ? parsed.tabs.filter(isTabKind) : []
    const requested = isTabKind(parsed.activeTab) ? parsed.activeTab : null
    return {
      tabs,
      // 持久化的 active 可能已被关掉：只认还在 tabs 里的
      activeTab: requested && tabs.includes(requested) ? requested : (tabs[0] ?? null),
      preset: normalizePreset(parsed.preset),
      ...(typeof parsed.customWidth === 'number' ? { customWidth: parsed.customWidth } : {}),
      follow: parsed.follow === true,
    }
  } catch {
    return null
  }
}

function savePersisted(workspaceDir: string, state: WorkbenchState): void {
  try {
    const persisted: PersistedWorkbench = {
      tabs: state.tabs,
      activeTab: state.activeTab,
      preset: state.preset,
      ...(state.customWidth !== undefined ? { customWidth: state.customWidth } : {}),
      follow: state.follow,
    }
    localStorage.setItem(storageKey(workspaceDir), JSON.stringify(persisted))
  } catch {
    // localStorage 不可用时静默降级到内存态
  }
}

const INITIAL: WorkbenchState = {
  open: false,
  // 默认落在产物页：用户打开工作台，十有八九是来看「这次产出了什么」
  tabs: ['artifacts'],
  activeTab: 'artifacts',
  preset: 'half',
  follow: false,
}

function seenKey(sessionKey: string): string {
  return `${SEEN_PREFIX}${sessionKey}`
}

/**
 * 读「上次看工作台」的时间。
 * 第一次进入某个会话**必须**初始化为当前时间——否则会话里历史几百个成品
 * 会在工具栏上变成一个巨大的角标（用户从没「错过」过他还没打开过的东西）。
 */
function loadSeen(sessionKey: string | null | undefined): number {
  if (!sessionKey) return Date.now()
  try {
    const raw = localStorage.getItem(seenKey(sessionKey))
    const parsed = raw ? Number(raw) : NaN
    if (Number.isFinite(parsed) && parsed > 0) return parsed
    const now = Date.now()
    localStorage.setItem(seenKey(sessionKey), String(now))
    return now
  } catch {
    return Date.now()
  }
}

/** Owns workbench visibility, open tabs, width preset, and file reveal state. */
export function useWorkspacePanels(
  activeView: ViewType | undefined,
  sessionKey?: string | null,
) {
  const [workbench, setWorkbench] = useState<WorkbenchState>(INITIAL)
  /** 「上次看工作台」的时间；切会话时重读，打开工作台即刷新（角标用） */
  const [lastSeenAt, setLastSeenAt] = useState<number>(() => loadSeen(sessionKey))
  /**
   * 「上次查看之后」分隔行的基准：打开工作台时**冻结上一次的值**。
   * 若与角标共用实时值，打开瞬间就被刷新，分隔行永远看不见——
   * 用户要的是「这次打开之后新增的」，不是「打开这一毫秒之后新增的」。
   */
  const [seenDividerSince, setSeenDividerSince] = useState<number>(() => loadSeen(sessionKey))
  const lastSeenRef = useRef(lastSeenAt)
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

  // 切会话：重读该会话的「上次查看」（没有记录就初始化为当前时间并落盘）
  useEffect(() => {
    const seen = loadSeen(sessionKey)
    // 同步更新 ref：同一提交里 markSeen 可能紧跟着跑（切会话时工作台还开着），
    // 若等下一个 effect 再同步，它会拿到上一个会话的时间，分隔行就消失
    lastSeenRef.current = seen
    setLastSeenAt(seen)
    setSeenDividerSince(seen)
  }, [sessionKey])

  useEffect(() => {
    lastSeenRef.current = lastSeenAt
  }, [lastSeenAt])

  const markSeen = useCallback(() => {
    const now = Date.now()
    // 先冻结「打开之前」的值给分隔行，再刷新角标的实时值
    setSeenDividerSince(lastSeenRef.current)
    setLastSeenAt(now)
    if (!sessionKey) return
    try {
      localStorage.setItem(seenKey(sessionKey), String(now))
    } catch {
      // localStorage 不可用就只在内存里生效
    }
  }, [sessionKey])

  // 打开工作台即清零角标（用户已经看到了）
  useEffect(() => {
    if (workbench.open) markSeen()
  }, [workbench.open, markSeen])

  const setFollow = useCallback((follow: boolean) => {
    setWorkbench((previous) => ({ ...previous, follow }))
  }, [])

  const closeWorkbench = useCallback(() => {
    setWorkbench((previous) => ({ ...previous, open: false }))
  }, [])

  /** 打开（或切到）一个页；已经开着就只切过去，不重复插 */
  const openPanel = useCallback((kind: WorkbenchTabKind) => {
    setWorkbench((previous) => {
      const next = openTab(previous.tabs, kind)
      return { ...previous, open: true, tabs: next.tabs, activeTab: next.active }
    })
  }, [])

  /**
   * 关一个页。关掉的若是最后一个，整列收起（DSH 的行为）——
   * 下次展开时没有 tab，自然落在开始页。
   */
  const closePanel = useCallback((kind: WorkbenchTabKind) => {
    setWorkbench((previous) => {
      const next = closeTab(previous.tabs, kind, previous.activeTab)
      if (!next) {
        return { ...previous, open: false, tabs: [], activeTab: null }
      }
      return { ...previous, tabs: next.tabs, activeTab: next.active }
    })
  }, [])

  const toggleWorkbench = useCallback(() => {
    setWorkbench((previous) =>
      previous.open
        ? { ...previous, open: false }
        : { ...previous, open: true },
    )
  }, [])

  /**
   * Agent 产出成品后自动打开「只看产出」工作台，便于浏览。
   * 不强制改用户持久化的列表/网格偏好（面板内默认即为网格）。
   */
  const openArtifactsWorkbench = useCallback(() => {
    setWorkbench((previous) => {
      const next = openTab(previous.tabs, 'artifacts')
      return { ...previous, open: true, tabs: next.tabs, activeTab: next.active }
    })
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
    setWorkbench((previous) => {
      const next = openTab(previous.tabs, 'files')
      return {
        ...previous,
        open: true,
        tabs: next.tabs,
        activeTab: next.active,
        selectedPath: undefined,
      }
    })
    setLocateFileTarget({
      path: toAbsolutePath(relativePath),
      token: locateTokenRef.current,
      preview: status !== 'deleted',
      fileName: relativePath.split('/').pop() ?? relativePath,
    })
  }, [toAbsolutePath])

  const revealInFiles = useCallback((relativePath: string) => {
    locateTokenRef.current += 1
    setWorkbench((previous) => {
      const next = openTab(previous.tabs, 'files')
      return {
        ...previous,
        open: true,
        tabs: next.tabs,
        activeTab: next.active,
        selectedPath: undefined,
      }
    })
    setLocateFileTarget({
      path: toAbsolutePath(relativePath),
      token: locateTokenRef.current,
    })
  }, [toAbsolutePath])

  const locateAbsoluteFile = useCallback((absolutePath: string) => {
    locateTokenRef.current += 1
    setWorkbench((previous) => {
      const next = openTab(previous.tabs, 'files')
      return { ...previous, open: true, tabs: next.tabs, activeTab: next.active }
    })
    setLocateFileTarget({ path: absolutePath, token: locateTokenRef.current })
  }, [])

  /**
   * 在 main 区打开一份稿件（`app_panel` 的 doc 模式 / 文件面板右键菜单 / 产物卡）。
   *
   * 文档不是一种 tab：它只是产物页 main 的一种预览内容。
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
    setWorkbench((previous) => {
      const next = openTab(previous.tabs, 'artifacts')
      return {
        ...previous,
        open: true,
        tabs: next.tabs,
        activeTab: next.active,
        selectedPath,
      }
    })
  }, [workspaceDir, toRelativePath])

  useEffect(() => {
    if (activeView && activeView !== 'chat') closeWorkbench()
  }, [activeView, closeWorkbench])

  return {
    workbench,
    lastSeenAt,
    seenDividerSince,
    markSeen,
    setFollow,
    locateFileTarget,
    uncommittedDiff,
    refreshVcs,
    toggleWorkbench,
    handleReviewTurnFileChange,
    closeWorkbench,
    openPanel,
    closePanel,
    openArtifactsWorkbench,
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
