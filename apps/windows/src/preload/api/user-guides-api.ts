/**
 * 内置使用指南 API（打包在 extraResources/user-guides）
 */
import { ipcRenderer } from 'electron'
import type { BundledUserGuideContent, BundledUserGuideIndex } from '../../shared/user-guides-types'

export const userGuidesApi = {
  /** 列出所有已打包指南索引 */
  list: (): Promise<readonly BundledUserGuideIndex[]> =>
    ipcRenderer.invoke('app:guides:list') as Promise<readonly BundledUserGuideIndex[]>,

  /** 按 id 读取 Markdown 正文 */
  read: (guideId: string): Promise<BundledUserGuideContent> =>
    ipcRenderer.invoke('app:guides:read', guideId) as Promise<BundledUserGuideContent>,
}
