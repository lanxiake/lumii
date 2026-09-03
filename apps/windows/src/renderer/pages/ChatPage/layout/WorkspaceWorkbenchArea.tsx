import React, { useRef, useCallback } from 'react'
import { WorkspaceWorkbench, type WorkbenchLayoutMode, type WorkbenchTab } from '../components/WorkspaceWorkbench'
import { WorkspaceFilePanel } from '../components/WorkspaceFilePanel'
import { WorkspaceVersionPanel } from '../components/WorkspaceVersionPanel/WorkspaceVersionPanel'

type WorkbenchProps = React.ComponentProps<typeof WorkspaceWorkbench>

export interface WorkspaceWorkbenchAreaProps {
  workbench: Pick<WorkbenchProps, 'open' | 'tab'>
  layoutMode: WorkbenchLayoutMode
  uncommittedCount: number
  locateFileTarget: React.ComponentProps<typeof WorkspaceFilePanel>['locateTarget']
  onTabChange: (tab: WorkbenchTab) => void
  onClose: () => void
  onWidthChange: NonNullable<WorkbenchProps['onWidthChange']>
  onResizingChange: NonNullable<WorkbenchProps['onResizingChange']>
  onLayoutModeChange: (mode: WorkbenchLayoutMode) => void
  onRevealInFiles: (relativePath: string) => void
}

/** Composes the files and VCS panels behind the workbench's stable shell. */
export const WorkspaceWorkbenchArea: React.FC<WorkspaceWorkbenchAreaProps> = ({
  workbench,
  layoutMode,
  uncommittedCount,
  locateFileTarget,
  onTabChange,
  onClose,
  onWidthChange,
  onResizingChange,
  onLayoutModeChange,
  onRevealInFiles,
}) => {
  const fileRefreshRef = useRef<(() => void) | null>(null)
  const vcsRefreshRef = useRef<(() => Promise<void>) | null>(null)

  const handleRefresh = useCallback(async () => {
    if (workbench.tab === 'files') {
      fileRefreshRef.current?.()
    } else if (workbench.tab === 'vcs') {
      await vcsRefreshRef.current?.()
    }
  }, [workbench.tab])

  return (
    <WorkspaceWorkbench
      open={workbench.open}
      tab={workbench.tab}
      onTabChange={onTabChange}
      onClose={onClose}
      uncommittedCount={uncommittedCount}
      onRefresh={handleRefresh}
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
        />
      }
      childrenVcs={
        <WorkspaceVersionPanel
          open={workbench.open}
          onClose={onClose}
          embedded
          layoutMode={layoutMode}
          onLayoutModeChange={onLayoutModeChange}
          onRevealInFiles={onRevealInFiles}
          refreshRef={vcsRefreshRef}
        />
      }
    />
  )
}
