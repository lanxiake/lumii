/**
 * WorkspaceWizard - 工作空间设置向导组件
 *
 * 首次登录时引导用户设置工作空间目录
 */

import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useSettings } from '../hooks/business/useSettings/useSettings'
import styles from './WorkspaceWizard.module.css'

// 首次登录标记 key
const FIRST_LOGIN_KEY = 'mtbot_first_login_done'

// 工作空间向导状态
type WizardState = 'hidden' | 'selecting' | 'migrating'

/**
 * 将旧工作空间目录的内容复制到新目录
 */
async function migrateWorkspaceData(oldDir: string, newDir: string): Promise<void> {
  console.log('[WorkspaceWizard] 工作空间迁移:', oldDir, '->', newDir)
  try {
    const exists = await window.electronAPI.file.exists(oldDir)
    if (!exists) {
      console.log('[WorkspaceWizard] 旧工作空间不存在，跳过迁移')
      return
    }

    const entries = await window.electronAPI.file.list(oldDir) as Array<{ name: string; isDirectory: boolean }>
    for (const entry of entries) {
      if (entry.name === '.lumii' || entry.name === 'projects') {
        console.log('[WorkspaceWizard] 跳过客户端内部/外部项目目录:', entry.name)
        continue
      }
      const srcPath = `${oldDir}/${entry.name}`
      const dstPath = `${newDir}/${entry.name}`
      await window.electronAPI.file.copy(srcPath, dstPath)
    }
    console.log('[WorkspaceWizard] 工作空间数据已复制到新目录')
  } catch (err) {
    console.error('[WorkspaceWizard] 工作空间迁移失败:', err)
    throw err
  }
}

/**
 * 工作空间向导弹窗组件
 */
export const WorkspaceWizard: React.FC = () => {
  const { settings, updateWorkspace, saveSettings } = useSettings()
  
  // 向导状态
  const [wizardState, setWizardState] = useState<WizardState>('hidden')
  const [selectedDir, setSelectedDir] = useState<string>('')
  const [migrateError, setMigrateError] = useState<string | null>(null)
  const [isMigrating, setIsMigrating] = useState(false)
  
  // 工作空间检查是否已完成
  const workspaceCheckDoneRef = useRef(false)

  /** 首次启动检测 */
  useEffect(() => {
    if (workspaceCheckDoneRef.current) return
    workspaceCheckDoneRef.current = true

    if (localStorage.getItem(FIRST_LOGIN_KEY)) return // 非首次启动，跳过

    console.log('[WorkspaceWizard] 首次启动，弹出工作空间向导')
    setWizardState('selecting')
  }, [])

  /**
   * 选择目录
   */
  const handleSelectDir = useCallback(async () => {
    const selectedPath = await window.electronAPI.workspace.selectDir()
    if (selectedPath) {
      setSelectedDir(selectedPath)
    }
  }, [])

  /**
   * 确认并迁移：先落盘主进程权威路径，再同步渲染侧设置（避免 saveSettings 闭包陈旧）
   */
  const handleConfirm = useCallback(async () => {
    if (!selectedDir) return
    
    setIsMigrating(true)
    setMigrateError(null)
    setWizardState('migrating')

    try {
      const oldDir = await window.electronAPI.workspace.getDir()
      await window.electronAPI.workspace.ensureDir(selectedDir)

      // 规范化路径以便比较（统一分隔符和大小写）
      const normalizeDir = (dir: string) => dir.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
      const normalizedOld = normalizeDir(oldDir)
      const normalizedNew = normalizeDir(selectedDir)

      if (oldDir && normalizedOld !== normalizedNew) {
        await migrateWorkspaceData(oldDir, selectedDir)
      }

      // 主进程权威源：setDir 与 notifyChanged 双写，确保重启后仍生效
      await window.electronAPI.workspace.setDir(selectedDir)
      await window.electronAPI.workspace.notifyChanged(selectedDir)

      updateWorkspace({ directory: selectedDir })
      // 直接写入 localStorage，避免 updateWorkspace 后立刻 saveSettings 读到旧闭包
      try {
        const next = {
          ...settings,
          workspace: { ...settings.workspace, directory: selectedDir },
        }
        localStorage.setItem('mtbot-assistant-settings', JSON.stringify(next))
      } catch {
        await saveSettings()
      }

      localStorage.setItem(FIRST_LOGIN_KEY, '1')
      setWizardState('hidden')
      console.log('[WorkspaceWizard] 工作空间已设置:', selectedDir)
    } catch (err) {
      setMigrateError(err instanceof Error ? err.message : '迁移失败')
      setWizardState('selecting')
    } finally {
      setIsMigrating(false)
    }
  }, [selectedDir, settings, updateWorkspace, saveSettings])

  /**
   * 跳过（使用默认）
   */
  const handleSkip = useCallback(() => {
    localStorage.setItem(FIRST_LOGIN_KEY, '1')
    setWizardState('hidden')
    console.log('[WorkspaceWizard] 工作空间向导已跳过，使用默认目录')
  }, [])

  // 隐藏状态不渲染
  if (wizardState === 'hidden') return null

  return (
    <div className={styles['modal-overlay']}>
      <div className={styles['modal-box']}>
        <h2 className={styles['modal-title']}>设置工作空间</h2>
        <p className={styles['modal-desc']}>
          这是您首次使用 Lumii。请选择一个目录作为工作空间，用于存储技能、文件和运行数据。
        </p>

        {migrateError && (
          <div className={styles['modal-error']}>迁移失败：{migrateError}</div>
        )}

        <div className={styles['wizard-dir-row']}>
          <input
            className={styles['wizard-dir-input']}
            readOnly
            value={selectedDir || '（使用默认目录）'}
          />
          <button
            className={styles['btn-secondary']}
            onClick={handleSelectDir}
            disabled={isMigrating}
          >
            浏览
          </button>
        </div>

        <div className={styles['modal-actions']}>
          <button
            className={styles['btn-secondary']}
            onClick={handleSkip}
            disabled={isMigrating}
          >
            使用默认
          </button>
          <button
            className={styles['btn-primary']}
            onClick={handleConfirm}
            disabled={!selectedDir || isMigrating}
          >
            {isMigrating ? '迁移中...' : '确认并继续'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default WorkspaceWizard
