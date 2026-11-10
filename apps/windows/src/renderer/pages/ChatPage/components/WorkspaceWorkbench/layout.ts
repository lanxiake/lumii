/**
 * 工作台宽度策略（纯函数，便于单测）。
 *
 * 宽度是「工作台的宽度」，与开了哪些 tab 无关——切 tab 不跳宽。
 */

/** 两栏（rail 清单 + main 预览）的 tab：它们共用一套"选中 → 预览"的结构 */
export type SplitTabKind = 'artifacts' | 'files'
/** 单栏 tab：内容自带完整布局，硬套 rail 会造出假栏 */
export type SingleTabKind = 'project' | 'terminal' | 'vcs'
export type WorkbenchTabKind = SplitTabKind | SingleTabKind

/** tab 条里的固定顺序（也是快捷键 1..N 的顺序） */
export const TAB_ORDER: readonly WorkbenchTabKind[] = [
  'artifacts',
  'files',
  'project',
  'terminal',
  'vcs',
]

export function isSplitTab(kind: WorkbenchTabKind | null): kind is SplitTabKind {
  return kind === 'artifacts' || kind === 'files'
}

/** 开始页的入口胶囊：打开后就是一个 tab */
export interface WorkbenchEntry {
  kind: WorkbenchTabKind
  title: string
  description: string
  /** 数字快捷键（1 起） */
  shortcut: string
}

export const WORKBENCH_ENTRIES: readonly WorkbenchEntry[] = [
  { kind: 'artifacts', title: '只看产出', description: '本会话的成品与过程文件', shortcut: '1' },
  { kind: 'files', title: '工作区文件', description: '浏览当前工作区的目录', shortcut: '2' },
  { kind: 'project', title: '项目', description: '挂载的项目与 git 状态', shortcut: '3' },
  { kind: 'terminal', title: '新建终端', description: '在项目目录里跑命令', shortcut: '4' },
  { kind: 'vcs', title: '版本', description: '变更与提交历史', shortcut: '5' },
]

export function entryFor(kind: WorkbenchTabKind): WorkbenchEntry {
  return WORKBENCH_ENTRIES.find((entry) => entry.kind === kind) ?? WORKBENCH_ENTRIES[0]
}

export function tabTitle(kind: WorkbenchTabKind): string {
  return entryFor(kind).title.replace(/^新建/, '')
}

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

/* ── tab 列表的纯操作（顺序即 tab 条顺序） ───────────────────────────── */

/** 打开 tab：已开则只切过去；否则按 TAB_ORDER 有序插入 */
export function openTab(
  tabs: readonly WorkbenchTabKind[],
  kind: WorkbenchTabKind,
): { tabs: WorkbenchTabKind[]; active: WorkbenchTabKind } {
  if (tabs.includes(kind)) return { tabs: [...tabs], active: kind }
  const rank = (k: WorkbenchTabKind): number => TAB_ORDER.indexOf(k)
  const next = [...tabs, kind].sort((a, b) => rank(a) - rank(b))
  return { tabs: next, active: kind }
}

/**
 * 关闭 tab。返回 null 表示"关掉的正是最后一个"——由调用方收起整列（DSH 的行为）。
 */
export function closeTab(
  tabs: readonly WorkbenchTabKind[],
  kind: WorkbenchTabKind,
  active: WorkbenchTabKind | null,
): { tabs: WorkbenchTabKind[]; active: WorkbenchTabKind | null } | null {
  const index = tabs.indexOf(kind)
  if (index < 0) return { tabs: [...tabs], active }
  const next = tabs.filter((item) => item !== kind)
  if (next.length === 0) return null
  if (active !== kind) return { tabs: next, active }
  // 关的是当前页：优先接管右边那个，没有就左边
  return { tabs: next, active: next[Math.min(index, next.length - 1)] ?? null }
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
