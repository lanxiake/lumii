/**
 * ExperimentalSection - 实验功能设置
 *
 * 合并自主进化和工具进化两个实验性功能
 */

import React, { useState, useEffect } from 'react'
import { FlaskConical } from 'lucide-react'
import { Card } from '../../../../components/ui/Card/Card'
import { Checkbox } from '../../../../components/ui/Checkbox/Checkbox'
import { useToast } from '../../../../components/ui/Toast/useToast'
import { AutonomousPage } from '../../../AutonomousPage/AutonomousPage'
import { EvolvedToolsSection } from '../EvolvedToolsSection'
import settingsStyles from '../../SettingsPage.module.css'
import styles from './ExperimentalSection.module.css'

async function sendCommand<T>(command: unknown): Promise<T> {
  return window.electronAPI.agentRuntime.sendCommand(command) as Promise<T>
}

export function ExperimentalSection() {
  const toast = useToast()
  const [toolEvolutionEnabled, setToolEvolutionEnabled] = useState(true)
  const [loading, setLoading] = useState(true)

  // 加载工具进化开关状态
  useEffect(() => {
    const loadStatus = async () => {
      try {
        const res = await sendCommand<{ ok: boolean; enabled: boolean; error?: string }>({
          type: 'tool-evolution:get-enabled',
        })
        if (res.ok) {
          setToolEvolutionEnabled(res.enabled)
        }
      } catch (err) {
        console.warn('[ExperimentalSection] 加载工具进化状态失败:', err)
      } finally {
        setLoading(false)
      }
    }
    void loadStatus()
  }, [])

  // 切换工具进化总开关
  const handleToggleToolEvolution = async (enabled: boolean) => {
    setLoading(true)
    try {
      const res = await sendCommand<{ ok: boolean; error?: string }>({
        type: 'tool-evolution:set-feature-enabled',
        enabled,
      })
      if (!res.ok) throw new Error(res.error || '操作失败')
      setToolEvolutionEnabled(enabled)
      toast.success(enabled ? '工具进化已启用' : '工具进化已禁用')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '切换失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.wrap}>
      {/* 自主进化 */}
      <div className={styles.section}>
        <div className={settingsStyles['autonomous-embed']}>
          <AutonomousPage embedded />
        </div>
      </div>

      {/* 工具进化 */}
      <div className={styles.section}>
        <Card className={settingsStyles.settingCard}>
          <div className={settingsStyles.settingCardHeader}>
            <FlaskConical size={20} />
            <h3>工具进化（实验）</h3>
          </div>
          <div className={settingsStyles.settingCardContent}>
            <div className={styles.featureToggle}>
              <Checkbox
                checked={toolEvolutionEnabled}
                onChange={handleToggleToolEvolution}
                disabled={loading}
              >
                启用工具进化功能
              </Checkbox>
              <span className={styles.featureHint}>
                关闭后，将停止追踪 bash 命令和生成候选工具，已批准的工具不受影响
              </span>
            </div>
          </div>
        </Card>

        {toolEvolutionEnabled && <EvolvedToolsSection />}
      </div>
    </div>
  )
}
