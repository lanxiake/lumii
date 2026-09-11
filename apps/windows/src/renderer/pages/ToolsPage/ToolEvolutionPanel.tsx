/**
 * ToolEvolutionPanel — 工具进化面板（工具菜单下）
 *
 * 包含工具进化总开关 + EvolvedToolsSection。
 * 挖掘策略：每 6 小时条件检查近一周高频模式（count>100、Top5），单次 LLM 草拟。
 */

import React, { useState, useEffect } from 'react'
import { FlaskConical } from 'lucide-react'
import { Card } from '../../components/ui/Card/Card'
import { Checkbox } from '../../components/ui/Checkbox/Checkbox'
import { useToast } from '../../components/ui/Toast/useToast'
import { EvolvedToolsSection } from '../SettingsPage/components/EvolvedToolsSection'
import styles from './ToolEvolutionPanel.module.css'

async function sendCommand<T>(command: unknown): Promise<T> {
  return window.electronAPI.agentRuntime.sendCommand(command) as Promise<T>
}

export function ToolEvolutionPanel() {
  const toast = useToast()
  const [featureEnabled, setFeatureEnabled] = useState(true)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadStatus = async () => {
      try {
        const res = await sendCommand<{
          ok: boolean
          enabled: boolean
          error?: string
        }>({
          type: 'tool-evolution:get-enabled',
        })
        if (res.ok) {
          setFeatureEnabled(res.enabled)
        }
      } catch (err) {
        console.warn('[ToolEvolutionPanel] 加载工具进化状态失败:', err)
      } finally {
        setLoading(false)
      }
    }
    void loadStatus()
  }, [])

  /** 切换工具进化总开关 */
  const handleToggle = async (enabled: boolean) => {
    setLoading(true)
    try {
      const res = await sendCommand<{ ok: boolean; error?: string }>({
        type: 'tool-evolution:set-feature-enabled',
        enabled,
      })
      if (!res.ok) throw new Error(res.error || '操作失败')
      setFeatureEnabled(enabled)
      toast.success(enabled ? '工具进化已启用' : '工具进化已禁用')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '切换失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.wrap}>
      <Card className={styles.switchCard}>
        <div className={styles.switchHeader}>
          <FlaskConical size={16} />
          <span className={styles.switchTitle}>功能开关</span>
        </div>
        <div className={styles.switchRow}>
          <Checkbox
            checked={featureEnabled}
            onChange={handleToggle}
            disabled={loading}
          >
            启用工具进化功能
          </Checkbox>
          <span className={styles.switchHint}>
            关闭后停止追踪与草拟；已批准工具不受影响。启用时约每 6 小时检查近一周调用：次数 &gt;100 且排名前 5 的模式才会调用 LLM 草拟工具。
          </span>
        </div>
      </Card>

      {featureEnabled && <EvolvedToolsSection />}
    </div>
  )
}

export default ToolEvolutionPanel
