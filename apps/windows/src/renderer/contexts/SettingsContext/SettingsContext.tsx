/**
 * SettingsContext - 已废弃，保留为向后兼容层
 *
 * 设置管理已迁移到 hooks/business/useSettings/useSettings.ts
 * 此文件仅作为过渡期的 re-export，后续可直接删除。
 *
 * @deprecated 请直接使用 hooks/business/useSettings/useSettings
 */

import React, { ReactNode } from 'react'
export { useSettings } from '../../hooks/business/useSettings/useSettings'
export type { AppSettings } from '../../hooks/business/useSettings/useSettings.types'

/** @deprecated 不再需要 Provider，保留仅为兼容 AppProviders.tsx */
export const SettingsProvider: React.FC<{ children: ReactNode; autoSave?: boolean; autoSaveDelay?: number }> = ({
  children,
}) => {
  return <>{children}</>
}

export default SettingsProvider
