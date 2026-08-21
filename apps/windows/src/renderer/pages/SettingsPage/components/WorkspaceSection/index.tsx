import React from 'react'
import { Badge } from '../../../../components/ui/Badge/Badge'
import { Button } from '../../../../components/ui/Button/Button'
import { Input } from '../../../../components/ui/Input/Input'
import { useToast } from '../../../../components/ui/Toast/useToast'
import type { AppSettings, WorkspaceConfig, UseCategorySettingsReturn } from '../../../../hooks/business/useSettings'
import styles from '../../SettingsPage.module.css'

interface WorkspaceSectionProps {
  settings: AppSettings
  defaultWorkspaceDir: string
  updateWorkspace: (config: Partial<WorkspaceConfig>) => void
  save: UseCategorySettingsReturn
}

export function WorkspaceSection({
  settings,
  defaultWorkspaceDir,
  updateWorkspace,
  save,
}: WorkspaceSectionProps) {
  const toast = useToast()

  const handleSelectWorkspaceDir = async () => {
    try {
      const selectedDir = await window.electronAPI.workspace.selectDir(
        settings.workspace.directory || defaultWorkspaceDir
      )
      if (selectedDir) {
        updateWorkspace({ directory: selectedDir })
      }
    } catch (err) {
      console.error('[WorkspaceSection] 选择工作空间目录失败:', err)
      toast.error(err instanceof Error ? err.message : '选择目录失败')
    }
  }

  const handleResetWorkspaceDir = async () => {
    console.log('[WorkspaceSection] 恢复默认工作空间目录')
    updateWorkspace({ directory: '' })
  }

  return (
    <div className={styles['settings-section']}>
      <h3 data-app-ui-section-title>
        工作空间
        {save.hasChanges && <Badge dot />}
      </h3>

      <div className={styles['setting-group']}>
        <div className={styles['setting-item']}>
          <label className={styles['setting-label']} data-app-ui-label>工作空间目录</label>
          <div className={styles['setting-hint']}>
            技能、命令、文件等默认存放在工作空间目录中。
            {!settings.workspace.directory && ' 当前使用默认路径。'}
          </div>
          <div className={styles['setting-row']}>
            <Input
              value={settings.workspace.directory || defaultWorkspaceDir}
              readOnly
              placeholder="未设置（使用默认路径）"
            />
            <Button onClick={handleSelectWorkspaceDir}>
              选择目录
            </Button>
          </div>
        </div>

        {settings.workspace.directory && (
          <div className={styles['setting-item']}>
            <Button
              variant="secondary"
              onClick={handleResetWorkspaceDir}
            >
              恢复默认
            </Button>
          </div>
        )}
      </div>

      <p className={styles['settings-note']}>
        更改工作空间目录后点击保存即可生效，无需重启。Agent 与命令执行将使用新目录；
        已安装的技能不会自动迁移到新目录。工作空间内文件被用户或 Agent 修改后，
        下次读取或执行时会自动看到最新内容，无需额外操作。
      </p>

      <div className={styles['category-save-actions']}>
        <Button
          onClick={save.save}
          loading={save.isSaving}
          disabled={save.isSaving || !save.hasChanges}
        >
          {save.saveStatus === 'saved'
            ? '✓ 已保存'
            : save.saveStatus === 'error'
              ? '保存失败'
              : save.hasChanges
                ? '保存工作空间设置'
                : '无更改'}
        </Button>
      </div>
    </div>
  )
}
