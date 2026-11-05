/**
 * 文件预览独立窗口 — 共享类型与 IPC 契约
 *
 * 独立 BrowserWindow 可拖出主窗口外，便于对照查看与缩放。
 */

/** 打开预览窗时传入的载荷 */
export interface FilePreviewWindowPayload {
  fileName: string
  fileId?: string
  filePath?: string
  userId?: string
  startLine?: number
  endLine?: number
  mdBasePath?: string
  editablePath?: string
  /**
   * 可左右切换的相邻文件（绝对路径，按展示顺序）。
   *
   * 独立预览窗是**另一个 BrowserWindow**，够不到主窗的产物台账——不把清单传过来，
   * 用户在主区能 ←/→ 翻页、弹出窗口后就翻不了，同一个预览两种能力。
   * 只放该翻的类型（图片/音视频），翻到一份 markdown 没有意义。
   */
  navigateList?: string[]
  /** 当前文件在 navigateList 里的下标 */
  navigateIndex?: number
}

/** file-preview IPC 通道名 */
export const FILE_PREVIEW_IPC = {
  /** invoke：打开或聚焦独立预览窗 */
  open: 'file-preview:open',
  /** invoke：关闭独立预览窗 */
  close: 'file-preview:close',
  /** invoke：预览窗渲染层拉取当前载荷 */
  getPayload: 'file-preview:get-payload',
  /**
   * invoke：在预览窗内左右切换相邻文件（-1 上一个 / 1 下一个）。
   *
   * 翻页的**清单在主进程**（随 open 的载荷带过来），渲染层只发方向——
   * 让渲染层自己算下标的话，主窗改了清单（删文件、重新筛选）两边就会对不上。
   */
  navigate: 'file-preview:navigate',
} as const
