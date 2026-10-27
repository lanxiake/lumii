/**
 * PPT 页级编辑契约（P2 T4）
 *
 * 页列表由 OOXML 文本提取（jszip，不依赖 Python）；真正的写回由主进程调用
 * 受管 Python + python-pptx 脚本完成，只改目标页的文本框。
 */

import type { ArtifactEditProposal } from './artifact-edit-types'

export interface SlideOutlineItem {
  /** 0-based */
  index: number
  /** 第一个非空文本（通常是标题） */
  title: string
  /** 该页所有非空文本，按文档顺序 */
  lines: string[]
  /** `<p:sp>` 元素数（语义比对用） */
  shapes: number
}

export interface SlideDepsInfo {
  ok: boolean
  reason?: string
}

export type SlideOutlineResult =
  | { ok: true; slides: readonly SlideOutlineItem[]; deps: SlideDepsInfo }
  | { ok: false; error: string }

export interface ProposeSlideEditInput {
  editId: string
  sessionKey?: string | null
  path: string
  /** 0-based */
  index: number
  action: 'slide-title' | 'slide-bullets'
  instruction?: string
}

/** 主进程 → Python 脚本的修改规格 */
export interface SlideEditSpec {
  title?: string
  bullets?: string[]
}

export interface SlideEditProposal extends ArtifactEditProposal {
  /** 候选稿的页列表（用于预览定位） */
  slides?: readonly SlideOutlineItem[]
}
