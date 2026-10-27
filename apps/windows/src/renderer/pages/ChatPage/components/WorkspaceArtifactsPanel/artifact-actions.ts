/**
 * 结果动作条的动作表（纯函数，便于表格驱动测试）
 *
 * 设计约束（§7.3 / T6）：一级动作最多 5 个，按 kind 配；**不可用的动作不出现**，
 * 不灰一片。所以这里只回答「这个 kind 该有哪几个一级入口」，能不能执行由调用方
 * 通过回调是否存在决定（例如没有「回到消息」能力时整条动作条不渲染）。
 */

import type { ArtifactKind } from '../../../../../shared/artifact-rules'
import type { Artifact } from './ledger'

export type ArtifactActionKey =
  /** 进入文档编辑（Markdown 写回；PPT 只读，给提示） */
  | 'edit'
  /** 导出 ▾（另存为 / 导出到文件夹 / 复制路径） */
  | 'exportMenu'
  /** 回到产生它的那条消息 */
  | 'locate'
  /** 加入并排对比 */
  | 'compare'
  /** 图片同源变体（只在声明了模型与提示词时出现） */
  | 'variant'
  /** ⋯（复制路径 / 在系统中打开 / 移入回收站） */
  | 'more'

/** 文档类：可编辑入口排在第一位（用户最常见的下一步） */
const DOC_KINDS: readonly ArtifactKind[] = ['doc', 'slides', 'sheet']
/** 媒体类：对比有用（选封面 / 选变体），不做编辑 */
const MEDIA_KINDS: readonly ArtifactKind[] = ['image', 'image-set', 'video', 'audio']

export interface PrimaryActionOptions {
  /** 图片声明了模型与原始提示词（`变体` 只在此时出现，D9） */
  canVariant?: boolean
}

export function primaryActionsFor(
  kind: ArtifactKind,
  options: PrimaryActionOptions = {},
): readonly ArtifactActionKey[] {
  if (DOC_KINDS.includes(kind)) return ['edit', 'exportMenu', 'locate', 'more']
  // 图片带「变体」时一级动作正好 5 个，仍满足上限
  if (kind === 'image' && options.canVariant) {
    return ['variant', 'exportMenu', 'locate', 'compare', 'more']
  }
  if (MEDIA_KINDS.includes(kind)) return ['exportMenu', 'locate', 'compare', 'more']
  return ['exportMenu', 'locate', 'more']
}

/** 导出 ▾ 的子项 */
export type ExportMenuKey = 'saveAs' | 'toFolder' | 'copyPath'
export const EXPORT_MENU: readonly ExportMenuKey[] = ['saveAs', 'toFolder', 'copyPath']

/** ⋯ 的子项 */
export type MoreMenuKey = 'copyPath' | 'undoEdit' | 'reveal' | 'trash'
export const MORE_MENU: readonly MoreMenuKey[] = ['copyPath', 'undoEdit', 'reveal', 'trash']

export const EXPORT_MENU_LABEL: Record<ExportMenuKey, string> = {
  saveAs: '另存为…',
  toFolder: '导出到文件夹…',
  copyPath: '复制路径',
}

export const MORE_MENU_LABEL: Record<MoreMenuKey, string> = {
  copyPath: '复制路径',
  undoEdit: '撤销最近一次本地修改',
  reveal: '在系统中打开',
  trash: '移入回收站…',
}

export const ACTION_LABEL: Record<Exclude<ArtifactActionKey, 'exportMenu' | 'more'>, string> = {
  edit: '编辑',
  locate: '定位',
  compare: '对比',
  variant: '变体',
}

/** 同源变体要复现的参数（D9：只认工具声明，没有就不给入口） */
export interface VariantSource {
  model: string
  sourcePrompt: string
  width?: number
  height?: number
}

export function variantSourceFor(artifact: Artifact | undefined): VariantSource | null {
  if (!artifact || artifact.kind !== 'image' || artifact.remoteUrl) return null
  const meta = artifact.meta
  const model = meta?.model?.trim()
  // 声明里有原始提示词就用它；只有改写后的 prompt 也能复现（老数据）
  const sourcePrompt = (meta?.sourcePrompt ?? meta?.prompt)?.trim()
  if (!model || !sourcePrompt) return null
  return {
    model,
    sourcePrompt,
    ...(meta?.width ? { width: meta.width } : {}),
    ...(meta?.height ? { height: meta.height } : {}),
  }
}
