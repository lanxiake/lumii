/**
 * 内置用户手册服务 — 封装 window.electronAPI.userGuides 的薄层
 */

import type { BundledUserGuideContent } from '../../shared/user-guides-types'

/** 读取内置用户手册全文；API 不可用时返回 null */
export async function readUserGuide(guideId: string): Promise<BundledUserGuideContent | null> {
  const api = window.electronAPI?.userGuides
  if (!api?.read) return null
  return api.read(guideId)
}
