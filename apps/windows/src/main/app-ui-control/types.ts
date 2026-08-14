/**
 * Agent 界面控制：快照与视图相关的共享类型（Part A「看」所需）。
 */

/** 截图快照中可点击/可引用的 UI 元素 */
export interface AppUiRef {
  ref: string
  role: string
  name: string
  x: number
  y: number
  w: number
  h: number
}

/** Settings Hub 打开状态 */
export interface AppUiHubState {
  open: boolean
  tab: string | null
  category: string | null
}

/** 主窗口当前视图与 Hub 状态（截图回传、后续 goto 回读共用） */
export interface AppUiViewState {
  view: string
  hub: AppUiHubState
}

/** 浏览器注入脚本返回的原始节点（尚未分配 ref） */
export interface RawSnapshotNode {
  role: string
  name: string
  x: number
  y: number
  w: number
  h: number
  /** 不可见（aria-hidden / display:none / 视口外等） */
  hidden?: boolean
  /** 带 data-app-ui-ignore，应排除 */
  ignored?: boolean
  /** data-app-ui 属性值，存在表示显式标记的可交互入口 */
  appUi?: string
}

/** filterSnapshotNodes 的返回结构 */
export interface FilterSnapshotResult {
  refs: AppUiRef[]
  truncated: boolean
}

/** filterSnapshotNodes 可选参数 */
export interface FilterSnapshotOptions {
  /** 最大保留节点数，默认 80 */
  limit?: number
}
