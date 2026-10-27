/**
 * 产物多选（纯函数）
 *
 * 区间选择只对「当前屏幕上真实可见的条目顺序」生效——传进来的 `order` 由调用方
 * 按渲染顺序拼好（展开的组 + 展开的折叠行）。收起的分组不该被 Shift 顺手选中，
 * 用户看不见的东西不能被偷偷带走。
 */

export type ToggleMode = 'toggle' | 'add' | 'range'

export interface SelectClickInput {
  /** 当前选中集 */
  selected: ReadonlySet<string>
  /** 可见条目顺序（工作区相对路径） */
  order: readonly string[]
  path: string
  mode: ToggleMode
  /** 上一次点击的锚点（Shift 区间用） */
  anchor: string | null
}

export interface SelectResult {
  selected: Set<string>
  /** 新的锚点 */
  anchor: string
}

/** 普通点击=单选；Ctrl/Cmd=加选/减选；Shift=从锚点到当前项的区间 */
export function applySelect(input: SelectClickInput): SelectResult {
  const { selected, order, path, mode, anchor } = input

  // Shift 但没有可用锚点（首次点击 / 锚点已被筛选挤掉）→ 退化成加选，
  // 而不是单选取代：用户按住 Shift 的意图是「往选择集里加」
  const wantRange = mode === 'range'
  if (wantRange && anchor) {
    const from = order.indexOf(anchor)
    const to = order.indexOf(path)
    if (from >= 0 && to >= 0) {
      const [start, end] = from <= to ? [from, to] : [to, from]
      const next = new Set(selected)
      for (let index = start; index <= end; index += 1) next.add(order[index]!)
      return { selected: next, anchor }
    }
  }

  if (mode === 'add' || wantRange) {
    const next = new Set(selected)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return { selected: next, anchor: path }
  }

  return { selected: new Set([path]), anchor: path }
}

/** 选择集里已经不在可见顺序中的项（筛选/切会话后清理用） */
export function pruneToVisible(
  selected: ReadonlySet<string>,
  order: readonly string[],
): Set<string> {
  const visible = new Set(order)
  const next = new Set<string>()
  for (const path of selected) if (visible.has(path)) next.add(path)
  return next
}
