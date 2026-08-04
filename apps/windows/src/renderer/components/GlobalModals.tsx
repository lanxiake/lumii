/**
 * GlobalModals - 全局弹窗组件（灵栖/Lumii 独立版）
 *
 * 独立版无网关：审批走 ChatPage 本地 Runtime 权限弹窗，定时通知走系统桌面通知。
 * 此处仅保留应用级 agent-error 的全局 toast。
 */

import React, { useEffect, useRef } from 'react'
import { useToast } from './ui/Toast/useToast'

/**
 * 全局弹窗管理组件
 */
export const GlobalModals: React.FC = () => {
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast

  useEffect(() => {
    const handleAgentError = (evt: Event) => {
      const { message } = (evt as CustomEvent).detail ?? {}
      if (message) {
        toastRef.current.showToast({ type: 'error', message, duration: 6000 })
      }
    }
    window.addEventListener('mtbot:agent-error', handleAgentError)
    return () => window.removeEventListener('mtbot:agent-error', handleAgentError)
  }, [])

  return null
}

export default GlobalModals
