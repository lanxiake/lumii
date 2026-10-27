/**
 * 可选 Toast：组件在 Provider 外也能渲染（单测、嵌入式预览）。
 *
 * `useToast()` 在无 Provider 时直接 throw——这对整页组件是对的（漏挂 Provider 就是 bug），
 * 但对 rail 这种「可能被独立挂载」的面板不友好：一个只有选中后才出现的提示条，
 * 不该让整个面板在无 Provider 环境里渲染失败。这里在无 Provider 时退回 no-op。
 */
import { useContext, useMemo } from 'react'
import { ToastContext } from './ToastContext'
import type { UseToastReturn } from './useToast'

const NOOP = (): string => ''

export function useOptionalToast(): UseToastReturn {
  const context = useContext(ToastContext)
  return useMemo<UseToastReturn>(() => {
    if (!context) {
      return {
        showToast: NOOP,
        hideToast: () => undefined,
        hideAllToasts: () => undefined,
        success: NOOP,
        error: NOOP,
        warning: NOOP,
        info: NOOP,
      }
    }
    const { showToast, hideToast, hideAllToasts } = context
    return {
      showToast,
      hideToast,
      hideAllToasts,
      success: (message, duration) => showToast({ type: 'success', message, duration }),
      error: (message, duration) => showToast({ type: 'error', message, duration }),
      warning: (message, duration) => showToast({ type: 'warning', message, duration }),
      info: (message, duration) => showToast({ type: 'info', message, duration }),
    }
  }, [context])
}
