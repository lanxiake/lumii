/**
 * VirtualHuman - 虚拟人展示框（原型 .pet.petprev）
 *
 * 只读展示当前虚拟人形象 + 模式状态，交互入口只有「打开/关闭宠物模式」，
 * 模型与人格配置仍在设置页（避免概览页出现第二份配置面板）。
 */

import React, { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { Card } from '../../../../components/ui/Card/Card'
import type { PetModelConfigDTO } from '../../../../../shared/pet-mode'
import {
  listPetModels,
  getCurrentPetModelId,
  getPetMode,
  switchPetMode,
  subscribePetModeChanged,
} from '../../../../services/pet-service'
import { useFeatureAvailability } from '../../../../hooks/business/useFeatureAvailability'
import clsx from 'clsx'
import styles from './VirtualHuman.module.css'

export const VirtualHuman: React.FC = () => {
  const { isAvailable, blockMessage, ready } = useFeatureAvailability()
  const petModeBlocked = !isAvailable('petMode')
  const [models, setModels] = useState<readonly PetModelConfigDTO[]>([])
  const [modelId, setModelId] = useState('')
  const [isPetMode, setIsPetMode] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  // 屏蔽平台上 pet:* 的 main 侧 handler 根本不注册（pet-mode-ipc.ts 入口层屏蔽），
  // 仍去调用只会在控制台刷 "No handler registered for 'pet:list-models'"，
  // 且拿不到任何数据。挂载点同样要在入口层短路，不是靠命令层兜底。
  //
  // **必须等 `ready`**：`isAvailable` 在矩阵取回前返回 true（见 hook 文件头），
  // 只判 `petModeBlocked` 的话首次渲染就把请求发出去了，这条 effect 等于没加。
  useEffect(() => {
    if (!ready || petModeBlocked) return undefined
    void listPetModels().then(setModels)
    void getCurrentPetModelId().then(setModelId)
    void getPetMode().then((mode) => {
      if (mode) setIsPetMode(mode === 'pet')
    })
    // 托盘 / 快捷键 / 控制坞切换也会广播到主窗口，状态由这一处统一同步
    return subscribePetModeChanged((mode) => setIsPetMode(mode === 'pet'))
  }, [ready, petModeBlocked])

  const model = models.find((m) => m.id === modelId) ?? models[0]

  const toggleMode = async () => {
    setBusy(true)
    setError(undefined)
    try {
      const result = await switchPetMode(isPetMode ? 'desktop' : 'pet')
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

      <button
        type="button"
        className={styles.action}
        onClick={toggleMode}
        disabled={busy || !model || petModeBlocked}
        title={petModeBlocked ? (blockMessage('petMode') ?? undefined) : undefined}
      >
        {isPetMode ? '关闭宠物模式' : '打开宠物模式'}
      </button>
      {/* D4：屏蔽必须给出原因，不能只是把按钮变灰 */}
      {petModeBlocked && <div className={styles.sub}>{blockMessage('petMode')}</div>}
      {error && <div className={styles.error}>{error}</div>}
    </Card>
  )
}

export default VirtualHuman
