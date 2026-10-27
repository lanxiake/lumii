/**
 * 工作台宽度策略（纯函数，便于单测）。
 *
 * 宽度是「工作台的宽度」，与视图 / 只看产出的开关无关——切视图不跳宽。
 */

export type WorkbenchView = 'workspace' | 'vcs'
export type WorkbenchPreset = 'half' | 'wide' | 'full' | 'custom'
/** 版本插件沿用的布局词汇（由 workbench preset 适配而来） */
export type WorkbenchLayoutMode = 'default' | 'wide' | 'fullscreen'

export const WORKBENCH_WIDTH_MIN = 240
/** 对话区至少保留的可见宽度（px） */
export const CHAT_MIN_REMAIN = 280

/** 半 480 / 宽 860 / 满 = 父容器可用宽度 */
export const WORKBENCH_WIDTH_PRESETS = {
  half: 480,
  wide: 860,
  full: 'max',
} as const

export const PRESET_LABEL: Record<'half' | 'wide' | 'full', string> = {
  half: '半',
  wide: '宽',
  full: '满',
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function resolveWidth(
  preset: WorkbenchPreset,
  customWidth: number | undefined,
  maxWidth: number,
): number {
  const max = Math.max(WORKBENCH_WIDTH_MIN, Math.floor(maxWidth))
  if (preset === 'full') return max
  if (preset === 'custom') {
    return clamp(customWidth ?? WORKBENCH_WIDTH_PRESETS.half, WORKBENCH_WIDTH_MIN, max)
  }
  return clamp(WORKBENCH_WIDTH_PRESETS[preset], WORKBENCH_WIDTH_MIN, max)
}

/** 单栏断点：< 560 时 rail 与 main 互斥（先列表，选中后预览 + 返回） */
export function isCompactWidth(width: number): boolean {
  return width < 560
}

/** rail 固定宽度：半档 220，其余 260 */
export function railWidthFor(workbenchWidth: number): number {
  return workbenchWidth < 560 ? 220 : 260
}

/** inspector 固定宽度（设计 §8：属性 + 版本历史） */
export const INSPECTOR_WIDTH = 240

/**
 * inspector 何时能并排：宽度 ≥900 才有位置。
 * 更窄时它退化成浮层，由「信息」按钮开关——否则 main 会被挤到没法看。
 */
export function isInspectorInline(workbenchWidth: number): boolean {
  return workbenchWidth >= 900
}

/** FNV-1a 32 位：给 localStorage key 防串档（不承担安全职责） */
export function hashWorkspaceDir(dir: string): string {
  let hash = 0x811c9dc5
  const normalized = dir.replace(/\\/g, '/').toLowerCase()
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}
