/**
 * 结果动作条的动作表（纯函数，便于表格驱动测试）
 *
 * 设计约束（§7.3 / T6）：一级动作最多 5 个，按 kind 配；**不可用的动作不出现**，
 * 不灰一片。所以这里只回答「这个 kind 该有哪几个一级入口」，能不能执行由调用方
 * 通过回调是否存在决定（例如没有「回到消息」能力时整条动作条不渲染）。
 */

import type { ArtifactKind } from '../../../../../shared/artifact-rules'

export type ArtifactActionKey =
  /** 进入文档编辑（Markdown 写回；PPT 只读，给提示） */
  | 'edit'
  /** 导出 ▾（另存为 / 导出到文件夹 / 复制路径） */
  | 'exportMenu'
  /** 回到产生它的那条消息 */
  | 'locate'
  /** 加入并排对比 */
  | 'compare'
  /** ⋯（复制路径 / 在系统中打开 / 移入回收站） */
  | 'more'

/** 文档类：可编辑入口排在第一位（用户最常见的下一步） */
const DOC_KINDS: readonly ArtifactKind[] = ['doc', 'slides', 'sheet']
/** 媒体类：对比有用（选封面 / 选变体），不做编辑 */
const MEDIA_KINDS: readonly ArtifactKind[] = ['image', 'image-set', 'video', 'audio']

export function primaryActionsFor(kind: ArtifactKind): readonly ArtifactActionKey[] {
  if (DOC_KINDS.includes(kind)) return ['edit', 'exportMenu', 'locate', 'more']
  if (MEDIA_KINDS.includes(kind)) return ['exportMenu', 'locate', 'compare', 'more']
  return ['exportMenu', 'locate', 'more']
}

/** 导出 ▾ 的子项 */
export type ExportMenuKey = 'saveAs' | 'toFolder' | 'copyPath'
export const EXPORT_MENU: readonly ExportMenuKey[] = ['saveAs', 'toFolder', 'copyPath']

/** ⋯ 的子项 */
export type MoreMenuKey = 'copyPath' | 'reveal' | 'trash'
export const MORE_MENU: readonly MoreMenuKey[] = ['copyPath', 'reveal', 'trash']

export const EXPORT_MENU_LABEL: Record<ExportMenuKey, string> = {
  saveAs: '另存为…',
  toFolder: '导出到文件夹…',
  copyPath: '复制路径',
}

export const MORE_MENU_LABEL: Record<MoreMenuKey, string> = {
  copyPath: '复制路径',
  reveal: '在系统中打开',
  trash: '移入回收站…',
}

export const ACTION_LABEL: Record<Exclude<ArtifactActionKey, 'exportMenu' | 'more'>, string> = {
  edit: '编辑',
  locate: '定位',
  compare: '对比',
}
