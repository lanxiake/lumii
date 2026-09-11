/**
 * ToolEvolutionPanel — 工具进化面板（工具菜单下）
 *
 * 包含工具进化总开关、调用次数触发阈值 + EvolvedToolsSection
 */

import React, { useState, useEffect } from 'react'
import { FlaskConical } from 'lucide-react'
import { Card } from '../../components/ui/Card/Card'
import { Checkbox } from '../../components/ui/Checkbox/Checkbox'
import { Input } from '../../components/ui/Input/Input'
import { useToast } from '../../components/ui/Toast/useToast'
import { EvolvedToolsSection } from '../SettingsPage/components/EvolvedToolsSection'
import styles from './ToolEvolutionPanel.module.css'

const DEFAULT_THRESHOLD = 50
const MIN_THRESHOLD = 10
const MAX_THRESHOLD = 500

async function sendCommand<T>(command: unknown): Promise<T> {
  return window.electronAPI.agentRuntime.sendCommand(command) as Promise<T>
}

/** 将输入钳制到合法触发阈值范围 */
function clampThreshold(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_THRESHOLD
  return Math.min(MAX_THRESHOLD, Math.max(MIN_THRESHOLD, Math.round(value)))
}

export function ToolEvolutionPanel() {
  const toast = useToast()
  const [featureEnabled, setFeatureEnabled] = useState(true)
  const [triggerThreshold, setTriggerThreshold] = useState(DEFAULT_THRESHOLD)
  const [thresholdDraft, setThresholdDraft] = useState(String(DEFAULT_THRESHOLD))
  const [loading, setLoading] = useState(true)
  const [savingThreshold, setSavingThreshold] = useState(false)

  useEffect(() => {
    const loadStatus = async () => {
      try {
        const res = await sendCommand<{
          ok: boolean
          enabled: boolean
          triggerThreshold?: number
          error?: string
        }>({
          type: 'tool-evolution:get-enabled',
        })
        if (res.ok) {
          setFeatureEnabled(res.enabled)
          const t = clampThreshold(res.triggerThreshold ?? DEFAULT_THRESHOLD)
          setTriggerThreshold(t)
          setThresholdDraft(String(t))
        }
      } catch (err) {
        console.warn('[ToolEvolutionPanel] 加载工具进化状态失败:', err)
      } finally {
        setLoading(false)
      }
    }
    void loadStatus()
  }, [])

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

  /** 提交触发阈值（失焦或回车） */
  const commitThreshold = async () => {
    const next = clampThreshold(Number(thresholdDraft))
    setThresholdDraft(String(next))
    if (next === triggerThreshold) return

    setSavingThreshold(true)
    try {
      const res = await sendCommand<{ ok: boolean; threshold?: number; error?: string }>({
        type: 'tool-evolution:set-trigger-threshold',
        threshold: next,
      })
      if (!res.ok) throw new Error(res.error || '保存失败')
      const saved = clampThreshold(res.threshold ?? next)
      setTriggerThreshold(saved)
      setThresholdDraft(String(saved))
      toast.success(`触发阈值已设为 ${saved} 次 / 24h`)
    } catch (err) {
      setThresholdDraft(String(triggerThreshold))
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSavingThreshold(false)
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
            关闭后，将停止追踪 bash 命令和生成候选工具，已批准的工具不受影响
          </span>
        </div>
        {featureEnabled && (
          <div className={styles.thresholdRow}>
            <label className={styles.thresholdLabel} htmlFor="tool-evo-trigger-threshold">
              过去 24 小时 bash 调用达到
            </label>
            <Input
              id="tool-evo-trigger-threshold"
              type="number"
              min={MIN_THRESHOLD}
              max={MAX_THRESHOLD}
              step={1}
              value={thresholdDraft}
              disabled={loading || savingThreshold}
              onChange={(e) => setThresholdDraft(e.target.value)}
              onBlur={() => void commitThreshold()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur()
                }
              }}
              className={styles.thresholdInput}
            />
            <span className={styles.thresholdSuffix}>次时触发分析（{MIN_THRESHOLD}–{MAX_THRESHOLD}）</span>
          </div>
        )}
      </Card>

      {featureEnabled && <EvolvedToolsSection />}
    </div>
  )
}

export default ToolEvolutionPanel
