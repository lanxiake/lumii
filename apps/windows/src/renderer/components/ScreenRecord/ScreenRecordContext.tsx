/**
 * ScreenRecordContext — 全局共享录屏 hook 状态
 */
import React, { createContext, useContext } from 'react'
import { useScreenRecord } from '../../hooks/useScreenRecord'

type ScreenRecordContextValue = ReturnType<typeof useScreenRecord>

const ScreenRecordContext = createContext<ScreenRecordContextValue | null>(null)

/**
 * 提供全局录屏状态（顶栏按钮 / 面板 / 确认弹窗共用）。
 */
export const ScreenRecordProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const value = useScreenRecord()
  return (
    <ScreenRecordContext.Provider value={value}>{children}</ScreenRecordContext.Provider>
  )
}

/**
 * 读取全局录屏状态；必须在 ScreenRecordProvider 内。
 */
export function useScreenRecordContext(): ScreenRecordContextValue {
  const ctx = useContext(ScreenRecordContext)
  if (!ctx) {
    throw new Error('useScreenRecordContext must be used within ScreenRecordProvider')
  }
  return ctx
}
