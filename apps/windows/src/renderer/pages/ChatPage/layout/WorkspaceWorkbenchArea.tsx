import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  WorkspaceWorkbench,
  type WorkbenchLayoutMode,
  type WorkbenchPreset,
  type WorkbenchView,
} from '../components/WorkspaceWorkbench'
import { WorkspaceFilePanel } from '../components/WorkspaceFilePanel'
import { SlotHost } from '../../../components/slots/SlotHost'
import { usePluginEnabled } from '../../../../plugins/renderer/state'
import { WorkspaceArtifactsPanel } from '../components/WorkspaceArtifactsPanel'
import { ArtifactInspector } from '../components/WorkspaceArtifactsPanel/ArtifactInspector'
import { ArtifactCompareView } from '../components/WorkspaceArtifactsPanel/CompareView'
import { ArtifactActionBar } from '../components/WorkspaceArtifactsPanel/ArtifactActionBar'
import { mapAllFiles, type AllArtifact } from '../components/WorkspaceArtifactsPanel/all-files'
import type { ArtifactScope } from '../components/WorkspaceArtifactsPanel'
import type { ExportMenuKey, MoreMenuKey } from '../components/WorkspaceArtifactsPanel/artifact-actions'
import { useOptionalToast } from '../../../components/ui/Toast/useOptionalToast'
import { writeClipboardFiles } from '../../../services/clipboard-service'
import {
  applySidecarMeta,
  buildArtifactLedger,
  formatClock,
  type Artifact,
  type ArtifactVersion,
} from '../components/WorkspaceArtifactsPanel/ledger'
import {
  VersionDiffView,
  VersionTextView,
} from '../components/WorkspaceArtifactsPanel/VersionViews'
import type { ArtifactVersionDiffResult } from '../../../../shared/artifact-version-types'
import { mergeLocalEdits } from '../components/WorkspaceArtifactsPanel/local-edits'
import { EditProposalPanel } from '../components/WorkspaceArtifactsPanel/EditProposalPanel'
import { ARTIFACT_EDITS_CHANGED_EVENT, useArtifactEdits } from '../hooks/useArtifactEdits'
import { artifactEditService } from '../../../services/artifact-edit-service'
import { buildTurnProgress } from '../components/WorkspaceArtifactsPanel/progress'
import { WorkspaceCleanupDialog } from '../components/WorkspaceCleanupDialog'
import { FilePreviewModal } from '../../../components/FilePreviewModal'
import type { PreviewSelectionPayload } from '../../../components/FilePreviewModal'
import { openFilePreviewWindow } from '../../../services/file-preview-service'
import { buildCardStates } from '../../../../shared/card-state'
import type { ArtifactSidecar } from '../../../../shared/artifact-declaration'
import type {
  ArtifactEditProposal,
  DocumentEditAction,
  EditTone,
} from '../../../../shared/artifact-edit-types'
import type { WorkbenchState } from '../hooks/useWorkspacePanels'
import type {
  PendingPermission,
  RuntimeMessage,
} from '../../../hooks/business/useAgentRuntime/agent-runtime-store'
import styles from './WorkspaceWorkbenchArea.module.css'

type WorkbenchProps = React.ComponentProps<typeof WorkspaceWorkbench>

export interface WorkspaceWorkbenchAreaProps {
  workbench: WorkbenchState
  uncommittedCount: number
  locateFileTarget: React.ComponentProps<typeof WorkspaceFilePanel>['locateTarget']
  /** 当前会话消息：产物台账直接从这里派生（历史与实时同一条路径） */
  messages: readonly RuntimeMessage[]
  toAbsolutePath: (relativePath: string) => string
  onViewChange: (view: WorkbenchView) => void
  onOnlyArtifactsChange: (onlyArtifacts: boolean) => void
  onPresetChange: NonNullable<WorkbenchProps['onPresetChange']>
  onSelect: (relativePath: string | undefined) => void
  onClose: () => void
  onRevealInFiles: (relativePath: string) => void
  /** 文件面板右键「打开」 */
  onOpenDoc: (absolutePath: string) => void
  /** 中断当前回合（与输入框停止按钮同一条通道） */
  onAbort: () => void
  /** 当前会话待审批（其它会话的审批不在这里抢） */
  pendingPermission?: PendingPermission
  /** 审批动作复用现有权限通道 */
  onRespondPermission?: (action: 'allow-once' | 'allow-always' | 'deny') => void
  /** 失败卡「重试」只把原 prompt 放回输入框 */
  onRetryPrompt?: (prompt: string) => void
  /** 「回到产生它的那条消息」：向上传到 ChatPage 做滚动定位 */
  onGoToMessage?: (messageId: string) => void
  /** 当前会话 key（inspector 查全会话版本历史用） */
  sessionKey?: string
  /** 「上次查看工作台」的时间（rail 分隔行） */
  lastSeenAt?: number
  /** 跟随本轮最新成品 */
  follow?: boolean
  onFollowChange?: (follow: boolean) => void
  /** 当前回合是否在流式运行（跟随只在运行时跟） */
  streaming?: boolean
  /** 工作区根目录（「全部」作用域把绝对路径相对化） */
  workspaceDir?: string
  /** 「全部」里点开一项：调用方负责切会话再预览 */
  onOpenArtifact?: (item: AllArtifact) => void
}

function isAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[/\\]/.test(value) || value.startsWith('/') || value.startsWith('\\\\')
}

function presetFromLayoutMode(mode: WorkbenchLayoutMode): WorkbenchPreset {
  if (mode === 'fullscreen') return 'full'
  if (mode === 'wide') return 'wide'
  return 'half'
}

function layoutModeFromPreset(preset: WorkbenchPreset): WorkbenchLayoutMode {
  if (preset === 'full') return 'fullscreen'
  if (preset === 'wide') return 'wide'
  return 'default'
}

/** Markdown 编辑态选中文字后的动作；tone:* 映射到「换语气」 */
const SELECTION_ACTIONS = [
  { id: 'rewrite', label: '改写' },
  { id: 'expand', label: '扩写' },
  { id: 'shorten', label: '精简' },
  { id: 'tone:formal', label: '更正式' },
  { id: 'tone:casual', label: '更口语' },
] as const

function newEditId(): string {
  return `edit-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
}

function versionLabelOf(version: ArtifactVersion): string {
  return `${version.source === 'local' ? '本地' : 'Agent'} ${formatClock(version.timestamp)}`
}


/** Composes the rail (artifacts / files) + embedded preview + VCS view. */
export const WorkspaceWorkbenchArea: React.FC<WorkspaceWorkbenchAreaProps> = ({
  workbench,
  uncommittedCount,
  locateFileTarget,
  messages,
  toAbsolutePath,
  onViewChange,
  onOnlyArtifactsChange,
  onPresetChange,
  onSelect,
  onClose,
  onRevealInFiles,
  onOpenDoc,
  onAbort,
  pendingPermission,
  onRespondPermission,
  onRetryPrompt,
  onGoToMessage,
  sessionKey,
  lastSeenAt,
  follow = false,
  onFollowChange,
  streaming = false,
  workspaceDir,
  onOpenArtifact,
}) => {
  const vcsEnabled = usePluginEnabled('com.lumii.vcs')
  const toast = useOptionalToast()
  const fileRefreshRef = useRef<(() => void) | null>(null)
  const vcsRefreshRef = useRef<(() => Promise<void>) | null>(null)
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const [intermediateBytes, setIntermediateBytes] = useState<number | undefined>(undefined)

  const ledgerMessages = useMemo(
    () =>
      messages.map((message) => ({
        id: message.id,
        role: message.role,
        timestamp: message.timestamp,
        ...(message.fileChanges ? { fileChanges: message.fileChanges } : {}),
        ...(message.sourceAgent?.label
          ? { sourceAgent: { label: message.sourceAgent.label } }
          : {}),
        // 只有 user 首句会用作任务组标签，assistant 正文不必拼
        ...(message.role === 'user'
          ? { text: message.content.map((block) => block.text).join('') }
          : {}),
        // 产物声明：只带台账需要的三列，避免把整条消息塞进纯函数
        ...(message.parts.length > 0
          ? {
              parts: message.parts.map((part) => ({
                type: part.type,
                ...(part.type === 'tool'
                  ? {
                      name: part.name,
                      ...(part.result !== undefined ? { result: part.result } : {}),
                    }
                  : {}),
              })),
            }
          : {}),
      })),
    [messages],
  )

  // 卡片/进度走「delta」：每个流式事件立即更新；
  // 台账是「snapshot 级」计算，降优先级重算，避免每个 token 全量扫会话（P0 L11）。
  const deferredLedgerMessages = useDeferredValue(ledgerMessages)
  const ledger = useMemo(
    () => buildArtifactLedger(deferredLedgerMessages),
    [deferredLedgerMessages],
  )
  const progress = useMemo(() => buildTurnProgress(messages), [messages])
  const cards = useMemo(() => buildCardStates(messages), [messages])

  // 侧车（PPT 等无工具层技能）：只给成品读，最多 200 个
  const [sidecarMetas, setSidecarMetas] = useState<Record<string, ArtifactSidecar>>({})
  const deliverablePaths = useMemo(
    () =>
      [
        ...new Set(
          ledger.groups.flatMap((group) => group.deliverables.map((item) => item.path)),
        ),
      ]
        .sort()
        .slice(0, 200),
    [ledger],
  )
  const deliverableSignature = deliverablePaths.join('\n')
  useEffect(() => {
    if (!workbench.open || deliverablePaths.length === 0) return
    const api = window.electronAPI?.artifact
    if (!api?.readMeta) return
    let cancelled = false
    void api
      .readMeta(deliverablePaths)
      .then((response) => {
        if (!cancelled && response.ok) setSidecarMetas(response.metas)
      })
      .catch(() => {
        // 侧车只是锦上添花；读失败保持派生结果
      })
    return () => {
      cancelled = true
    }
    // deliverableSignature 覆盖「同一批路径」；数组本身每次台账重建都是新引用
  }, [workbench.open, deliverableSignature]) // eslint-disable-line react-hooks/exhaustive-deps

  const enrichedLedger = useMemo(
    () => applySidecarMeta(ledger, sidecarMetas),
    [ledger, sidecarMetas],
  )
  // 本地编辑（工作台改写 / 手工保存）不在消息里：合并成卡片，但不伪造 turn
  const { edits: localEdits } = useArtifactEdits(sessionKey, workbench.open)
  const mergedLedger = useMemo(
    () => mergeLocalEdits(enrichedLedger, localEdits),
    [enrichedLedger, localEdits],
  )
  /** 清理时保护「声明/派生为成品」的路径；即使路径长得像过程文件也不删 */
  const protectedPaths = useMemo(
    () =>
      [
        ...new Set(
          mergedLedger.groups.flatMap((group) => group.deliverables.map((item) => item.path)),
        ),
      ].sort(),
    [mergedLedger],
  )

  const hasIntermediates = mergedLedger.counts.intermediates > 0
  const refreshBytes = useCallback(async () => {
    const api = window.electronAPI?.workspace
    if (!api?.cleanupScan) return
    try {
      const response = await api.cleanupScan({ budgetMs: 1500 })
      if (response.ok) setIntermediateBytes(response.scan.classes.intermediate.bytes)
    } catch {
      // 体积只是辅助信息，拿不到就不显示
    }
  }, [])

  useEffect(() => {
    if (!workbench.open || !hasIntermediates) return
    void refreshBytes()
  }, [workbench.open, hasIntermediates, refreshBytes])

  const layoutMode = layoutModeFromPreset(workbench.preset)
  const handleLayoutModeChange = useCallback(
    (mode: WorkbenchLayoutMode) => onPresetChange(presetFromLayoutMode(mode)),
    [onPresetChange],
  )

  const handleRefresh = useCallback(async () => {
    if (workbench.view === 'vcs') {
      await vcsRefreshRef.current?.()
    } else if (!workbench.onlyArtifacts) {
      fileRefreshRef.current?.()
    }
  }, [workbench.view, workbench.onlyArtifacts])

  // 产物台账完全由消息派生，没有可手动刷新的外部状态
  const onRefresh =
    workbench.view === 'vcs' || !workbench.onlyArtifacts ? handleRefresh : undefined

  const openWindow = useCallback((absolutePath: string, fileName: string) => {
    void openFilePreviewWindow({ filePath: absolutePath, fileName })
  }, [])

  const selected = workbench.selectedPath
  const absoluteSelected = selected
    ? isAbsolutePath(selected)
      ? selected
      : toAbsolutePath(selected)
    : undefined
  const selectedName = absoluteSelected?.split(/[\\/]/).pop() ?? absoluteSelected

  // 对比模式：main 换成并排视图；退出（Esc / 点某一格 / 关闭工作台）回普通预览
  const [comparePaths, setComparePaths] = useState<readonly string[]>([])
  /** 本次会话里已经删掉的路径：历史 fileChanges 仍会派生卡片，这里统一隐藏 */
  const [trashedPaths, setTrashedPaths] = useState<ReadonlySet<string>>(new Set())
  const comparing = comparePaths.length > 0

  const exitCompare = useCallback(() => setComparePaths([]), [])

  const compareArtifacts = useMemo(() => {
    if (!comparing) return []
    const byPath = new Map<string, Artifact>()
    for (const group of mergedLedger.groups) {
      for (const item of group.deliverables) byPath.set(item.path, item)
      for (const item of group.intermediates) byPath.set(item.path, item)
    }
    const out: Artifact[] = []
    for (const path of comparePaths) {
      const hit = byPath.get(path)
      if (hit) out.push(hit)
    }
    return out
  }, [comparing, comparePaths, mergedLedger])

  // 对比期间 Esc 退出（预览本身也吃 Esc，所以只在对比时挂）。
  // 用捕获阶段 + stopPropagation：工作台的 Esc 会关掉整个工作台，对比应先吃掉这一下。
  useEffect(() => {
    if (!comparing) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      exitCompare()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [comparing, exitCompare])

  // 对比的项被删/被恢复后可能一个都不剩：别留一个空对比面板
  useEffect(() => {
    if (comparing && compareArtifacts.length === 0) exitCompare()
  }, [comparing, compareArtifacts.length, exitCompare])

  // 工作台关掉时一并退出对比，避免下次打开直接落在对比视图里
  useEffect(() => {
    if (!workbench.open) setComparePaths([])
  }, [workbench.open])

  const handleCompareSelect = useCallback(
    (paths: readonly string[]) => setComparePaths(paths),
    [],
  )

  // ── 「全部」作用域（client_files 登记，跨会话） ──
  const [scope, setScope] = useState<ArtifactScope>('session')
  const [allItems, setAllItems] = useState<readonly AllArtifact[]>([])
  const [allLoading, setAllLoading] = useState(false)
  useEffect(() => {
    if (scope !== 'all' || !workbench.open) return
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand) return
    let cancelled = false
    setAllLoading(true)
    api
      .sendCommand({ type: 'files:list', userId: 'local-user', limit: 100 })
      .then((response) => {
        if (cancelled) return
        const files = (response as { files?: unknown })?.files
        setAllItems(Array.isArray(files) ? mapAllFiles(files as never[], workspaceDir) : [])
      })
      .catch(() => {
        if (!cancelled) setAllItems([])
      })
      .finally(() => {
        if (!cancelled) setAllLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [scope, workbench.open, workspaceDir])

  // 关掉工作台再打开时回到本会话（「全部」是临时视角，不记忆）
  useEffect(() => {
    if (!workbench.open) setScope('session')
  }, [workbench.open])

  /**
   * 跟随模式：运行中，最新成品一变就把 main 切过去。
   * 用户点卡/搜索/折叠会通过 `onFollowChange(false)` 主动交出控制权（设计 §7.5）。
   */
  const latestDeliverable = useMemo(() => {
    let best: { path: string; timestamp: number } | undefined
    for (const group of mergedLedger.groups) {
      for (const item of group.deliverables) {
        if (!best || item.timestamp > best.timestamp) {
          best = { path: item.path, timestamp: item.timestamp }
        }
      }
    }
    return best?.path
  }, [mergedLedger])

  useEffect(() => {
    if (!follow || !streaming || !workbench.open || !latestDeliverable) return
    if (workbench.selectedPath === latestDeliverable) return
    onSelect(latestDeliverable)
  }, [follow, streaming, workbench.open, latestDeliverable, workbench.selectedPath, onSelect])

  const handleTrashed = useCallback((paths: readonly string[]) => {
    setTrashedPaths((previous) => {
      const next = new Set(previous)
      for (const path of paths) next.add(path)
      return next
    })
  }, [])

  // main 用渲染函数：对比视图要知道当前工作台宽度（<860 只并排 2 项）
  // inspector 只对「选中且来自台账」的产物出现：文件面板里的普通文件没有版本历史
  const [inspectorOpen, setInspectorOpen] = useState(false)
  /** P2 就地修改：loading / ready / error 三态提案；应用后 previewVersion 触发重载 */
  const [editStatus, setEditStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [editProposal, setEditProposal] = useState<ArtifactEditProposal | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const [previewVersion, setPreviewVersion] = useState(0)
  const editTokenRef = useRef(0)
  const pendingEditIdRef = useRef<string | null>(null)
  const editProposalRef = useRef<ArtifactEditProposal | null>(null)
  /** T3：版本对照 / 只读预览（main 区替代预览） */
  type VersionViewState =
    | {
        kind: 'diff'
        fromLabel: string
        toLabel: string
        result: ArtifactVersionDiffResult
      }
    | { kind: 'text'; label: string; text: string; approximate?: boolean }
  const [versionView, setVersionView] = useState<VersionViewState | null>(null)
  const selectedArtifact = useMemo(() => {
    if (!selected) return undefined
    for (const group of mergedLedger.groups) {
      const hit =
        group.deliverables.find((item) => item.path === selected) ??
        group.intermediates.find((item) => item.path === selected)
      if (hit) return hit
    }
    return undefined
  }, [mergedLedger, selected])

  /** 最近一次本地修改（listEdits 已按时间倒序）；有才显示「撤销」菜单项 */
  const undoableEdit = useMemo(() => {
    if (!selectedArtifact) return undefined
    return localEdits.find((edit) => edit.path === selectedArtifact.path)
  }, [localEdits, selectedArtifact])

  // 换产物时收起浮层：新产物默认不弹，宽档的并排栏会自己出现
  useEffect(() => {
    setInspectorOpen(false)
  }, [selectedArtifact?.path])

  const inspectorNode =
    selectedArtifact && onGoToMessage ? (
      <ArtifactInspector
        artifact={selectedArtifact}
        {...(sessionKey ? { sessionKey } : {})}
        {...(mergedLedger.versions.get(selectedArtifact.path)
          ? { versions: mergedLedger.versions.get(selectedArtifact.path)! }
          : {})}
        onGoToTurn={onGoToMessage}
        onShowDiff={(version, previous) => void handleShowVersionDiff(version, previous)}
        onPreviewVersion={(version) => void handlePreviewVersion(version)}
        onClose={() => setInspectorOpen(false)}
      />
    ) : undefined

  // ── 结果动作条（main 底部）──
  /** rail 里的多选（动作条的「对比」要与它合并） */
  const [railSelection, setRailSelection] = useState<readonly string[]>([])
  /** 点过「编辑」的产物：把预览直接推进 Markdown 编辑态 */
  const [editTarget, setEditTarget] = useState<string | null>(null)
  useEffect(() => {
    setEditTarget(null)
  }, [selectedArtifact?.path])

  const handleEditArtifact = (): void => {
    if (!selectedArtifact) return
    if (selectedArtifact.kind === 'slides') {
      // PPT 单页编辑在 P2；先如实告诉用户，而不是给一个点不动的按钮
      toast.info('PPT 单页编辑在 P2；这里先看预览')
      return
    }
    setEditTarget(selectedArtifact.path)
  }

  const copyArtifactPath = async (): Promise<void> => {
    if (!selectedArtifact) return
    try {
      await writeClipboardFiles([toAbsolutePath(selectedArtifact.path)])
      toast.success('已复制文件到剪贴板')
    } catch {
      toast.error('复制失败')
    }
  }

  const handleExportMenu = async (menu: ExportMenuKey): Promise<void> => {
    if (!selectedArtifact) return
    if (menu === 'copyPath') {
      await copyArtifactPath()
      return
    }
    const api = window.electronAPI?.artifact
    if (!api?.exportFiles) return
    try {
      const result = await api.exportFiles(
        [selectedArtifact.path],
        menu === 'saveAs' ? 'save' : 'copy',
      )
      if (result.ok) toast.success(`已导出到 ${result.destPath ?? '目标位置'}`)
      else if (result.error !== '已取消') toast.error(result.error ?? '导出失败')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导出失败')
    }
  }

  const handleMoreMenu = async (menu: MoreMenuKey): Promise<void> => {
    if (!selectedArtifact) return
    if (menu === 'copyPath') {
      await copyArtifactPath()
      return
    }
    if (menu === 'undoEdit') {
      const edit = localEdits.find((item) => item.path === selectedArtifact.path)
      if (!edit) {
        toast.info('没有可撤销的本地修改')
        return
      }
      const result = await artifactEditService.undoEdit(edit.editId)
      if (!result.ok) {
        toast.error(result.error)
        return
      }
      window.dispatchEvent(new CustomEvent(ARTIFACT_EDITS_CHANGED_EVENT))
      setPreviewVersion((value) => value + 1)
      setVersionView(null)
      toast.success('已撤销最近一次本地修改')
      return
    }
    if (menu === 'reveal') {
      void window.electronAPI?.app?.showItemInFolder?.(toAbsolutePath(selectedArtifact.path))
      return
    }
    const api = window.electronAPI?.artifact
    if (!api?.trash) return
    try {
      const result = await api.trash([selectedArtifact.path])
      if (!result.ok) {
        toast.error(result.error ?? '删除失败')
        return
      }
      handleTrashed([selectedArtifact.path])
      toast.success('已移入回收站（可在「清理…」里恢复）')
      onSelect(undefined)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    }
  }

  const handleCompareCurrent = (): void => {
    if (!selectedArtifact) return
    const merged = [...new Set([selectedArtifact.path, ...railSelection])]
    if (merged.length < 2) {
      toast.info('在左侧按住 Ctrl 再选一项，就能并排对比')
      return
    }
    setComparePaths(merged)
  }

  useEffect(() => {
    editProposalRef.current = editProposal
  }, [editProposal])

  /**
   * 清空提案；生成中按 editId 取消；已就绪的候选在换产物/换会话时一并丢弃，
   * 避免 `.lumii/edits` 里留下没人用的候选目录。
   */
  const clearEditProposal = useCallback((abortPending = true, discardProposal = false) => {
    editTokenRef.current += 1
    const pending = pendingEditIdRef.current
    pendingEditIdRef.current = null
    if (abortPending && pending) void artifactEditService.abortEdit(pending)
    if (discardProposal && editProposalRef.current) {
      void artifactEditService.discardEdit(editProposalRef.current.editId)
    }
    setEditStatus('idle')
    setEditProposal(null)
    setEditError(null)
    setEditBusy(false)
  }, [])

  const handleSelectionAction = useCallback(
    async (actionId: string, selection: PreviewSelectionPayload) => {
      if (!selected) return
      const [kind, toneValue] = actionId.split(':')
      let action: DocumentEditAction
      let tone: EditTone | undefined
      if (kind === 'rewrite' || kind === 'expand' || kind === 'shorten') {
        action = kind
      } else if (kind === 'tone') {
        action = 'tone'
        tone = toneValue === 'casual' || toneValue === 'confident' ? toneValue : 'formal'
      } else {
        return
      }

      const editId = newEditId()
      const token = ++editTokenRef.current
      pendingEditIdRef.current = editId
      setEditStatus('loading')
      setEditProposal(null)
      setEditError(null)
      setEditBusy(false)
      try {
        const result = await artifactEditService.proposeEdit({
          editId,
          ...(sessionKey ? { sessionKey } : {}),
          path: selected,
          start: selection.start,
          end: selection.end,
          action,
          ...(tone ? { tone } : {}),
          baseHash: selection.baseHash,
        })
        if (editTokenRef.current !== token) return
        if (!result.ok) {
          if (result.code === 'cancelled') clearEditProposal(false)
          else {
            setEditStatus('error')
            setEditError(result.error)
          }
          return
        }
        setEditProposal(result)
        setEditStatus('ready')
      } catch (err) {
        if (editTokenRef.current !== token) return
        setEditStatus('error')
        setEditError(err instanceof Error ? err.message : '生成改写建议失败')
      } finally {
        if (editTokenRef.current === token) pendingEditIdRef.current = null
      }
    },
    [clearEditProposal, selected, sessionKey],
  )

  const handleApplyProposal = useCallback(async () => {
    if (!editProposal) return
    setEditBusy(true)
    try {
      const result = await artifactEditService.applyEdit(editProposal.editId)
      if (!result.ok) {
        toast.error(result.error)
        setEditBusy(false)
        return
      }
      if (result.warning) toast.warning(result.warning)
      else toast.success('已应用；可在 ⋯ 里撤销最近一次本地修改')
      window.dispatchEvent(new CustomEvent(ARTIFACT_EDITS_CHANGED_EVENT))
      setPreviewVersion((value) => value + 1)
      setVersionView(null)
      clearEditProposal(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '应用失败')
      setEditBusy(false)
    }
  }, [clearEditProposal, editProposal, toast])

  const handleDiscardProposal = useCallback(() => {
    const proposal = editProposal
    clearEditProposal(false)
    if (proposal) void artifactEditService.discardEdit(proposal.editId)
  }, [clearEditProposal, editProposal])

  /** T3：与上一版做文本 diff；内容不可取时面板里给原因 */
  const handleShowVersionDiff = useCallback(
    async (version: ArtifactVersion, previous: ArtifactVersion) => {
      if (!selectedArtifact) return
      if (!version.versionId || !previous.versionId) {
        toast.info('版本信息尚未加载完成')
        return
      }
      const targetSession = selectedArtifact.conversationId ?? sessionKey
      if (!targetSession) {
        toast.error('缺少会话信息，无法读取版本')
        return
      }
      clearEditProposal(true, true)
      try {
        const result = await artifactEditService.versionDiff({
          sessionKey: targetSession,
          path: selectedArtifact.path,
          fromVersionId: previous.versionId,
          toVersionId: version.versionId,
        })
        setVersionView({
          kind: 'diff',
          fromLabel: versionLabelOf(previous),
          toLabel: versionLabelOf(version),
          result,
        })
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '读取版本差异失败')
      }
    },
    [clearEditProposal, selectedArtifact, sessionKey, toast],
  )

  const handlePreviewVersion = useCallback(
    async (version: ArtifactVersion) => {
      if (!selectedArtifact || !version.versionId) return
      const targetSession = selectedArtifact.conversationId ?? sessionKey
      if (!targetSession) {
        toast.error('缺少会话信息，无法读取版本')
        return
      }
      clearEditProposal(true, true)
      try {
        const result = await artifactEditService.versionContent({
          sessionKey: targetSession,
          path: selectedArtifact.path,
          versionId: version.versionId,
        })
        if (!result.ok) {
          toast.error(result.reason)
          return
        }
        setVersionView({
          kind: 'text',
          label: versionLabelOf(version),
          text: result.text,
          ...(result.approximate ? { approximate: true } : {}),
        })
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '读取版本内容失败')
      }
    },
    [clearEditProposal, selectedArtifact, sessionKey, toast],
  )

  // 换产物 / 换会话 / 进对比：取消在飞请求、丢弃候选并清空提案
  useEffect(() => {
    clearEditProposal(true, true)
  }, [selected, sessionKey, clearEditProposal])

  useEffect(() => {
    if (comparing) {
      clearEditProposal(true, true)
      setVersionView(null)
    }
  }, [comparing, clearEditProposal])

  // 换产物/换会话：版本对照/预览回到普通预览
  useEffect(() => {
    setVersionView(null)
  }, [selected, sessionKey])

  const renderMainContent = (width: number): React.ReactNode => {
    if (versionView?.kind === 'diff') {
      return (
        <VersionDiffView
          path={selectedArtifact?.path ?? ''}
          fromLabel={versionView.fromLabel}
          toLabel={versionView.toLabel}
          result={versionView.result}
          onClose={() => setVersionView(null)}
        />
      )
    }
    if (versionView?.kind === 'text') {
      return (
        <VersionTextView
          path={selectedArtifact?.path ?? ''}
          label={versionView.label}
          text={versionView.text}
          {...(versionView.approximate ? { approximate: true } : {})}
          onClose={() => setVersionView(null)}
        />
      )
    }
    return comparing ? (
      <ArtifactCompareView
        items={compareArtifacts}
        toAbsolutePath={toAbsolutePath}
        width={width}
        onPick={(relativePath) => {
          exitCompare()
          onSelect(relativePath)
        }}
        onExit={exitCompare}
      />
    ) : absoluteSelected ? (
      <FilePreviewModal
        key={`${absoluteSelected}-${previewVersion}`}
        variant="embedded"
        filePath={absoluteSelected}
        fileName={selectedName ?? absoluteSelected}
        {...(editTarget && editTarget === selected ? { initialEdit: true } : {})}
        selectionActions={SELECTION_ACTIONS}
        onSelectionAction={(actionId, selection) => {
          void handleSelectionAction(actionId, selection)
        }}
        selectionBusy={editStatus === 'loading'}
        onClose={() => onSelect(undefined)}
      />
    ) : (
      <div className={styles.empty}>
        <p className={styles.emptyTitle}>还没有打开产物</p>
        <p className={styles.emptyHint}>
          在左侧点任一产物在这里预览；双击可以开独立窗口。
        </p>
        <button
          type="button"
          className={styles.emptyAction}
          onClick={() => onOnlyArtifactsChange(false)}
        >
          浏览工作区文件
        </button>
      </div>
    )
  }

  const main = ({ width }: { width: number }) => (
    <div className={styles.mainColumn}>
      <div className={styles.mainContent}>{renderMainContent(width)}</div>
      {!comparing && editStatus !== 'idle' && (
        <EditProposalPanel
          status={editStatus}
          proposal={editProposal}
          error={editError}
          busy={editBusy}
          onApply={() => void handleApplyProposal()}
          onDiscard={handleDiscardProposal}
          onCancel={() => clearEditProposal(true, false)}
        />
      )}
      {!comparing && selectedArtifact && (
        <ArtifactActionBar
          artifact={selectedArtifact}
          onEdit={handleEditArtifact}
          onExport={(menu) => void handleExportMenu(menu)}
          onMore={(menu) => void handleMoreMenu(menu)}
          onLocate={() => {
            if (selectedArtifact.turnId) onGoToMessage?.(selectedArtifact.turnId)
            else toast.info('这是本地修改，没有对应的对话消息')
          }}
          onCompare={handleCompareCurrent}
          canUndoEdit={Boolean(undoableEdit)}
        />
      )}
    </div>
  )

  return (
    <>
      <WorkspaceWorkbench
        open={workbench.open}
        view={workbench.view}
        onlyArtifacts={workbench.onlyArtifacts}
        preset={workbench.preset}
        {...(workbench.customWidth !== undefined
          ? { customWidth: workbench.customWidth }
          : {})}
        {...(selected ? { selectedPath: selected } : {})}
        onViewChange={onViewChange}
        onOnlyArtifactsChange={onOnlyArtifactsChange}
        onPresetChange={onPresetChange}
        onClose={onClose}
        onBack={() => onSelect(undefined)}
        {...(absoluteSelected && selectedName
          ? { onOpenSelectedWindow: () => openWindow(absoluteSelected, selectedName) }
          : {})}
        uncommittedCount={uncommittedCount}
        onRefresh={onRefresh}
        vcsEnabled={vcsEnabled}
        rail={
          workbench.onlyArtifacts ? (
            <WorkspaceArtifactsPanel
              ledger={mergedLedger}
              toAbsolutePath={toAbsolutePath}
              {...(selected ? { selectedPath: selected } : {})}
              onSelect={onSelect}
              onOpenWindow={openWindow}
              onCompare={handleCompareSelect}
              onSelectionChange={setRailSelection}
              scope={scope}
              onScopeChange={setScope}
              allItems={allItems}
              allLoading={allLoading}
              {...(onOpenArtifact ? { onOpenAll: onOpenArtifact } : {})}
              {...(lastSeenAt !== undefined ? { lastSeenAt } : {})}
              follow={follow}
              {...(onFollowChange ? { onFollowChange } : {})}
              trashedPaths={trashedPaths}
              onTrashed={handleTrashed}
              {...(progress ? { progress } : {})}
              onAbort={onAbort}
              cards={cards}
              {...(onRetryPrompt ? { onRetryPrompt } : {})}
              {...(pendingPermission && onRespondPermission
                ? {
                    interrupt: {
                      title: pendingPermission.description || `${pendingPermission.toolName} 需要授权`,
                      detail: pendingPermission.toolName,
                      onAllowOnce: () => onRespondPermission('allow-once'),
                      onAllowAlways: () => onRespondPermission('allow-always'),
                      onDeny: () => onRespondPermission('deny'),
                    },
                  }
                : {})}
              onCleanup={() => setCleanupOpen(true)}
              {...(intermediateBytes !== undefined ? { intermediateBytes } : {})}
            />
          ) : (
            <WorkspaceFilePanel
              open={workbench.open}
              onClose={onClose}
              locateTarget={locateFileTarget}
              embedded
              refreshRef={fileRefreshRef}
              onOpenInDoc={onOpenDoc}
            />
          )
        }
        main={main}
        {...(inspectorNode ? { inspector: inspectorNode } : {})}
        inspectorOpen={inspectorOpen}
        onInspectorOpenChange={setInspectorOpen}
        childrenVcs={
          <SlotHost
            name="workspace.version"
            context={
              {
                open: workbench.open,
                onClose,
                embedded: true,
                layoutMode,
                onLayoutModeChange: handleLayoutModeChange,
                onRevealInFiles,
                refreshRef: vcsRefreshRef,
              } as unknown as Record<string, unknown>
            }
          />
        }
      />

      {/* 变更来源：聊天里的「查看本轮变更」仍走文件定位 */}
      <WorkspaceCleanupDialog
        open={cleanupOpen}
        onClose={() => setCleanupOpen(false)}
        onCleaned={() => void refreshBytes()}
        protectedPaths={protectedPaths}
      />
    </>
  )
}
