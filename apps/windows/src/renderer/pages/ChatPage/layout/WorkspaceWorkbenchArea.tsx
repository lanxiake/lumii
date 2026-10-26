import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { buildArtifactLedger } from '../components/WorkspaceArtifactsPanel/ledger'
import { buildTurnProgress } from '../components/WorkspaceArtifactsPanel/progress'
import { WorkspaceCleanupDialog } from '../components/WorkspaceCleanupDialog'
import { FilePreviewModal } from '../../../components/FilePreviewModal'
import { openFilePreviewWindow } from '../../../services/file-preview-service'
import type { WorkbenchState } from '../hooks/useWorkspacePanels'
import type { RuntimeMessage } from '../../../hooks/business/useAgentRuntime/agent-runtime-store'
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
      })),
    [messages],
  )

  const ledger = useMemo(() => buildArtifactLedger(ledgerMessages), [ledgerMessages])
  const progress = useMemo(() => buildTurnProgress(messages), [messages])

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

  const main = absoluteSelected ? (
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
              ledger={ledger}
              toAbsolutePath={toAbsolutePath}
              {...(selected ? { selectedPath: selected } : {})}
              onSelect={onSelect}
              onOpenWindow={openWindow}
              {...(progress ? { progress } : {})}
              onAbort={onAbort}
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
      />
    </>
  )
}
