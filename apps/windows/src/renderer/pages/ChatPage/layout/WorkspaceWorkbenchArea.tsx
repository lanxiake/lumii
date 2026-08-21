import React from 'react'
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
  onRefresh: () => void
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
  onRefresh,
  onWidthChange,
  onResizingChange,
  onLayoutModeChange,
  onRevealInFiles,
}) => (
  <WorkspaceWorkbench
    open={workbench.open}
    tab={workbench.tab}
    onTabChange={onTabChange}
    onClose={onClose}
    uncommittedCount={uncommittedCount}
    onRefresh={onRefresh}
    onWidthChange={onWidthChange}
    onResizingChange={onResizingChange}
    layoutMode={layoutMode}
    onLayoutModeChange={onLayoutModeChange}
    childrenFiles={
      <WorkspaceFilePanel open={workbench.open} onClose={onClose} locateTarget={locateFileTarget} embedded />
    }
    childrenVcs={
      <WorkspaceVersionPanel
        open={workbench.open}
        onClose={onClose}
        embedded
        layoutMode={layoutMode}
        onLayoutModeChange={onLayoutModeChange}
        onRevealInFiles={onRevealInFiles}
      />
    }
  />
)
