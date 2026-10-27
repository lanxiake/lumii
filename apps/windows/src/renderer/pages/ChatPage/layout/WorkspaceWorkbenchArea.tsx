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
import {
  applySidecarMeta,
  buildArtifactLedger,
  type Artifact,
} from '../components/WorkspaceArtifactsPanel/ledger'
import { buildTurnProgress } from '../components/WorkspaceArtifactsPanel/progress'
import { WorkspaceCleanupDialog } from '../components/WorkspaceCleanupDialog'
import { FilePreviewModal } from '../../../components/FilePreviewModal'
import { openFilePreviewWindow } from '../../../services/file-preview-service'
import { buildCardStates } from '../../../../shared/card-state'
import type { ArtifactSidecar } from '../../../../shared/artifact-declaration'
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
}) => {
  const vcsEnabled = usePluginEnabled('com.lumii.vcs')
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
  /** 清理时保护「声明/派生为成品」的路径；即使路径长得像过程文件也不删 */
  const protectedPaths = useMemo(
    () =>
      [
        ...new Set(
          enrichedLedger.groups.flatMap((group) => group.deliverables.map((item) => item.path)),
        ),
      ].sort(),
    [enrichedLedger],
  )

  const hasIntermediates = ledger.counts.intermediates > 0
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
    for (const group of enrichedLedger.groups) {
      for (const item of group.deliverables) byPath.set(item.path, item)
      for (const item of group.intermediates) byPath.set(item.path, item)
    }
    const out: Artifact[] = []
    for (const path of comparePaths) {
      const hit = byPath.get(path)
      if (hit) out.push(hit)
    }
    return out
  }, [comparing, comparePaths, enrichedLedger])

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

  const handleTrashed = useCallback((paths: readonly string[]) => {
    setTrashedPaths((previous) => {
      const next = new Set(previous)
      for (const path of paths) next.add(path)
      return next
    })
  }, [])

  // main 用渲染函数：对比视图要知道当前工作台宽度（<860 只并排 2 项）
  const main = ({ width }: { width: number }) =>
    comparing ? (
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
        key={absoluteSelected}
        variant="embedded"
        filePath={absoluteSelected}
        fileName={selectedName ?? absoluteSelected}
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

  // inspector 只对「选中且来自台账」的产物出现：文件面板里的普通文件没有版本历史
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const selectedArtifact = useMemo(() => {
    if (!selected) return undefined
    for (const group of enrichedLedger.groups) {
      const hit =
        group.deliverables.find((item) => item.path === selected) ??
        group.intermediates.find((item) => item.path === selected)
      if (hit) return hit
    }
    return undefined
  }, [enrichedLedger, selected])

  // 换产物时收起浮层：新产物默认不弹，宽档的并排栏会自己出现
  useEffect(() => {
    setInspectorOpen(false)
  }, [selectedArtifact?.path])

  const inspectorNode =
    selectedArtifact && onGoToMessage ? (
      <ArtifactInspector
        artifact={selectedArtifact}
        {...(sessionKey ? { sessionKey } : {})}
        {...(enrichedLedger.versions.get(selectedArtifact.path)
          ? { versions: enrichedLedger.versions.get(selectedArtifact.path)! }
          : {})}
        onGoToTurn={onGoToMessage}
        onClose={() => setInspectorOpen(false)}
      />
    ) : undefined

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
              ledger={enrichedLedger}
              toAbsolutePath={toAbsolutePath}
              {...(selected ? { selectedPath: selected } : {})}
              onSelect={onSelect}
              onOpenWindow={openWindow}
              onCompare={handleCompareSelect}
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
