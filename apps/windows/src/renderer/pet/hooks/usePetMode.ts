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

    // **补问一次当前模型**。主进程只在**切换时**推 `model:changed`，而页面加载
    // （HMR / reload / 冷启动）之后它不会再推——不补问的话 `currentModelId`
    // 一直是空串，PetCanvas 会回退到**默认模型**：用户明明选了别的宠物，
    // 看到的却是默认那只；而且默认模型没有 Climb/Crawl/Fall，
    // 攀爬时会一路播成待机姿势（实测：爬到墙上站着不动地往上飘）。
    //
    // 与 `getIdleStage` / `getPerchRect` 是同一族问题，修法也一样。
    void pet
      .getCurrentModelId()
      .then((id) => {
        if (id) setCurrentModelId(id)
      })
      .catch(() => {
        // 拿不到就用默认模型，不打断挂载
      })

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
