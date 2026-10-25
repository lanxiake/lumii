import React, { useRef, useCallback, useMemo } from 'react'
import type { FileChangeEntry } from '@mtbot/agent-runtime/browser'
import { WorkspaceWorkbench, type WorkbenchLayoutMode, type WorkbenchTab } from '../components/WorkspaceWorkbench'
import { WorkspaceFilePanel } from '../components/WorkspaceFilePanel'
import { SlotHost } from '../../../components/slots/SlotHost'
import { usePluginEnabled } from '../../../../plugins/renderer/state'
import { WorkspaceChangesPanel } from '../components/WorkspaceChangesPanel'
import { buildChangeLedger } from '../components/WorkspaceChangesPanel/ledger'
import { FilePreviewModal } from '../../../components/FilePreviewModal'
import type { RuntimeMessage } from '../../../hooks/business/useAgentRuntime/agent-runtime-store'

type WorkbenchProps = React.ComponentProps<typeof WorkspaceWorkbench>

export interface WorkspaceWorkbenchAreaProps {
  workbench: Pick<WorkbenchProps, 'open' | 'tab'>
  layoutMode: WorkbenchLayoutMode
  uncommittedCount: number
  locateFileTarget: React.ComponentProps<typeof WorkspaceFilePanel>['locateTarget']
  /** 「文档」Tab 当前稿件绝对路径；为空则整个 Tab 不出现 */
  docPath: string | null
  /** 当前会话消息：变更台账直接从这里派生（历史与实时同一条路径） */
  messages: readonly RuntimeMessage[]
  toAbsolutePath: (relativePath: string) => string
  onTabChange: (tab: WorkbenchTab) => void
  onClose: () => void
  onWidthChange: NonNullable<WorkbenchProps['onWidthChange']>
  onResizingChange: NonNullable<WorkbenchProps['onResizingChange']>
  onLayoutModeChange: (mode: WorkbenchLayoutMode) => void
  onRevealInFiles: (relativePath: string) => void
  onRevealChange: (relativePath: string, status: FileChangeEntry['status']) => void
  /** 文件面板右键「在文档 Tab 打开」 */
  onOpenDoc: (absolutePath: string) => void
}

/** Composes the files, changes and VCS panels behind the workbench's stable shell. */
export const WorkspaceWorkbenchArea: React.FC<WorkspaceWorkbenchAreaProps> = ({
  workbench,
  layoutMode,
  uncommittedCount,
  locateFileTarget,
  docPath,
  messages,
  toAbsolutePath,
  onTabChange,
  onClose,
  onWidthChange,
  onResizingChange,
  onLayoutModeChange,
  onRevealInFiles,
  onRevealChange,
  onOpenDoc,
}) => {
  const vcsEnabled = usePluginEnabled('com.lumii.vcs')
  const fileRefreshRef = useRef<(() => void) | null>(null)
  const vcsRefreshRef = useRef<(() => Promise<void>) | null>(null)

  const ledger = useMemo(() => buildChangeLedger(messages), [messages])

  const handleRefresh = useCallback(async () => {
    if (workbench.tab === 'files') {
      fileRefreshRef.current?.()
    } else if (workbench.tab === 'vcs') {
      await vcsRefreshRef.current?.()
    }
  }, [workbench.tab])

  // 变更台账完全由消息派生，没有可手动刷新的外部状态；doc 由编辑器自己管保存
  const onRefresh =
    workbench.tab === 'changes' || workbench.tab === 'doc' ? undefined : handleRefresh

  return (
    <WorkspaceWorkbench
      open={workbench.open}
      tab={workbench.tab}
      onTabChange={onTabChange}
      onClose={onClose}
      uncommittedCount={uncommittedCount}
      changeCount={ledger.counts.files}
      onRefresh={onRefresh}
      onWidthChange={onWidthChange}
      onResizingChange={onResizingChange}
      layoutMode={layoutMode}
      onLayoutModeChange={onLayoutModeChange}
      childrenFiles={
        <WorkspaceFilePanel
          open={workbench.open}
          onClose={onClose}
          locateTarget={locateFileTarget}
          embedded
          refreshRef={fileRefreshRef}
          onOpenInDoc={onOpenDoc}
        />
      }
      childrenChanges={
        <WorkspaceChangesPanel
          ledger={ledger}
          toAbsolutePath={toAbsolutePath}
          onRevealInFiles={onRevealChange}
        />
      }
      vcsEnabled={vcsEnabled}
      docEnabled={!!docPath}
      childrenDoc={
        docPath ? (
          <FilePreviewModal
            variant="embedded"
            filePath={docPath}
            fileName={docPath.split(/[\\/]/).pop() ?? docPath}
            onClose={() => onTabChange('files')}
          />
        ) : null
      }
      childrenVcs={
        <SlotHost
          name="workspace.version"
          context={
            {
              open: workbench.open,
              onClose,
              embedded: true,
              layoutMode,
              onLayoutModeChange,
              onRevealInFiles,
              refreshRef: vcsRefreshRef,
            } as unknown as Record<string, unknown>
          }
        />
      }
    />
  )
}
