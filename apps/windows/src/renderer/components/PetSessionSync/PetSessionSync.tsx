/**
 * PetSessionSync — 把主窗口当前 sessionKey 同步到主进程（纯副作用组件，渲染 null）
 *
 * 供独立宠物窗口语音通话跟随当前 Chat 会话（D4 决策）；
 * 同时把当前会话的 thinking 偏好推给 runtime。
 *
 * **两件事的可达性不同**：宠物那条走 `pet:*` IPC，屏蔽平台（Linux）上
 * `registerPetModeIpc` 在入口层直接 return、handler 根本没注册，调用只会在控制台刷
 * `No handler registered for 'pet:set-active-session-key'`；thinking 偏好与宠物无关，
 * 任何平台都要照常发。所以判据只能包住前者。
 */
import React, { useEffect } from 'react'
import {
  useAgentRuntimeActions,
  useAgentRuntimeGlobalState,
} from '../../hooks/business/useAgentRuntime/useAgentRuntime'
import { useFeatureAvailability } from '../../hooks/business/useFeatureAvailability'
import { readPersistedSessionThinkingPrefs } from '../../../shared/session-thinking-prefs'
import { setActiveSessionKey } from '../../services/pet-service'

export const PetSessionSync: React.FC = () => {
  const currentSessionKey = useAgentRuntimeGlobalState((s) => s.currentSessionKey)
  const runtimeActions = useAgentRuntimeActions()
  const { isAvailable, ready } = useFeatureAvailability()
  const petModeBlocked = !isAvailable('petMode')

  useEffect(() => {
    if (!currentSessionKey) return
    // **必须等 `ready`**：`isAvailable` 在矩阵取回前返回 true（刻意的降级取向，
    // 见 hook 文件头）。只判 petModeBlocked 的话首次渲染就把请求发出去了，
    // 这条短路等于没加。
    if (ready && !petModeBlocked) void setActiveSessionKey(currentSessionKey)

    const prefs = readPersistedSessionThinkingPrefs()
    void runtimeActions.setSessionThinkingPrefs(currentSessionKey, prefs)
  }, [currentSessionKey, runtimeActions, ready, petModeBlocked])

  return null
}
