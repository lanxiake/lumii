/**
 * VirtualHuman - 虚拟人展示框（原型 .pet.petprev）
 *
 * 只读展示当前虚拟人形象 + 模式状态，交互入口只有「进入/退出宠物模式」，
 * 模型与人格配置仍在设置页（避免概览页出现第二份配置面板）。
 */

import React, { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { Card } from '../../../../components/ui/Card/Card'
import type { PetModelConfigDTO } from '../../../../../shared/pet-mode'
import clsx from 'clsx'
import styles from './VirtualHuman.module.css'

export const VirtualHuman: React.FC = () => {
  const [models, setModels] = useState<readonly PetModelConfigDTO[]>([])
  const [modelId, setModelId] = useState('')
  const [isPetMode, setIsPetMode] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    const pet = window.electronAPI?.pet
    if (!pet) return
    void pet.listModels().then(setModels).catch(() => {})
    void pet.getCurrentModelId().then(setModelId).catch(() => {})
    void pet.getMode().then((mode) => setIsPetMode(mode === 'pet')).catch(() => {})
    // 托盘 / 快捷键 / 控制坞切换也会广播到主窗口，状态由这一处统一同步
    const onModeChanged = (mode: unknown) => setIsPetMode(mode === 'pet')
    window.electronAPI.on('pet-mode-changed', onModeChanged)
    return () => window.electronAPI.off('pet-mode-changed', onModeChanged)
  }, [])

  const model = models.find((m) => m.id === modelId) ?? models[0]

  const toggleMode = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const result = await window.electronAPI?.pet?.switchMode(isPetMode ? 'desktop' : 'pet')
      if (result && !result.success) setError(result.error ?? '切换失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className={styles.panel} flush>
      <div className={styles.head}>
        <span className={styles.title}>虚拟人</span>
        <span className={clsx(styles.tag, isPetMode && styles['tag--on'])}>
          {isPetMode ? '宠物模式中' : '待机'}
        </span>
      </div>

      <div className={styles.stage}>
        <span className={styles.aura} aria-hidden="true" />
        <span className={styles.ring} style={{ width: 92, height: 92 }} aria-hidden="true" />
        <span
          className={clsx(styles.ring, styles['ring--outer'])}
          style={{ width: 118, height: 118 }}
          aria-hidden="true"
        />
        {model?.thumbnailUrl ? (
          <img className={styles.avatar} src={model.thumbnailUrl} alt={model.name} />
        ) : (
          <span className={styles.placeholder} aria-hidden="true">
            <Sparkles size={34} strokeWidth={1.4} />
          </span>
        )}
      </div>

      <div className={styles.meta}>
        <span className={styles.name}>{model?.name ?? '未配置形象'}</span>
        <span className={styles.sub}>
          {model ? `Live2D · 共 ${models.length} 个形象` : '在设置页添加虚拟人形象'}
        </span>
      </div>

      <button type="button" className={styles.action} onClick={toggleMode} disabled={busy || !model}>
        {isPetMode ? '退出宠物模式' : '进入宠物模式'}
      </button>
      {error && <div className={styles.error}>{error}</div>}
    </Card>
  )
}

export default VirtualHuman
