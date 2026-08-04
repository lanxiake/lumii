/**
 * usePetMode - 宠物模式渲染层 hook
 *
 * 负责：
 * 1. 监听主进程 prepare 事件 → 通知主进程渲染层就绪（握手第 6 步）
 * 2. 订阅 mode:changed 事件，供组件响应模式变化
 * 3. 暴露 switchMode / currentMode 给控制面板
 */

import { useEffect, useState, useCallback, useRef } from 'react'
import type { AppMode, PetModeChangedEvent } from '../../../shared/pet-mode'
import { petMetrics } from '../telemetry/pet-metrics'

export function usePetMode() {
  const [currentMode, setCurrentMode] = useState<AppMode>('pet')
  const [currentModelId, setCurrentModelId] = useState<string>('')
  const prepareTsRef = useRef<number>(0)

  useEffect(() => {
    const pet = window.electronAPI?.pet
    if (!pet) return

    // 监听 prepare 事件并立即回复就绪（握手）
    const unsubPrepare = pet.onModePrepare((evt) => {
      prepareTsRef.current = performance.now()
      void pet.notifyRendererReady(evt.targetMode)
    })

    // 监听模式变更
    const unsubChanged = pet.onModeChanged((evt: PetModeChangedEvent) => {
      if (prepareTsRef.current > 0) {
        petMetrics.recordModeSwitch(performance.now() - prepareTsRef.current)
        prepareTsRef.current = 0
      }
      setCurrentMode(evt.mode)
      setCurrentModelId(evt.modelId)
    })

    // 监听模型热切换（不重建窗口，仅更新 modelId → PetCanvas 重载，B-3）
    const unsubModelChanged = pet.onModelChanged?.((evt) => {
      setCurrentModelId(evt.modelId)
    })

    // 初始化：通知主进程宠物窗口渲染层已就绪
    void pet.notifyRendererReady('pet')

    return () => {
      unsubPrepare()
      unsubChanged()
      unsubModelChanged?.()
    }
  }, [])

  const exitPetMode = useCallback(async () => {
    await window.electronAPI?.pet?.switchMode('desktop')
  }, [])

  const toggleForceIgnore = useCallback(async () => {
    return window.electronAPI?.pet?.toggleForceIgnoreMouse()
  }, [])

  return { currentMode, currentModelId, exitPetMode, toggleForceIgnore }
}
