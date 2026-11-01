/**
 * 语音唤醒监听器（纯副作用组件，渲染 null）。
 *
 * 挂在主窗口上，由 `useVoiceWake` 负责开麦推流；
 * 判定与"进宠物模式"都在主进程（见 `voice-wake-hub.ts`），这里只负责让它跑起来。
 */
import React from 'react'
import { useVoiceWake } from '../../hooks/business/useVoiceWake'

export const VoiceWakeListener: React.FC = () => {
  // 状态本身在主窗口没有可见 UI；保留返回值的意图是以后状态条要显示"正在等唤醒"
  useVoiceWake()
  return null
}
