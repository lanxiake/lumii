/**
 * 内置使用指南类型（打包在 extraResources/user-guides）
 */

/** manifest.json 中的单条指南索引 */
export interface BundledUserGuideIndex {
  readonly id: string
  readonly title: string
  readonly category: string
  readonly description: string
  readonly tags: readonly string[]
  readonly file: string
  /** 未来启动时可写入 Wiki 资料库 */
  readonly seedToWiki: boolean
  readonly updatedAt: string
}

/** manifest.json 根结构 */
export interface BundledUserGuidesManifest {
  readonly version: number
  readonly generatedAt: string
  readonly guides: readonly BundledUserGuideIndex[]
}

/** IPC 读取指南正文响应 */
export interface BundledUserGuideContent {
  readonly id: string
  readonly title: string
  readonly markdown: string
  readonly updatedAt: string
}
