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

/** 主窗口路由视图（对齐 Router.tsx ViewType） */
export type AppUiViewType =
  | 'dashboard'
  | 'chat'
  | 'skills'
  | 'settings'
  | 'memories'
  | 'agents'
  | 'cron'
  | 'plugins'
  | 'mcp'

/** Settings Hub 分类（对齐 SettingsHub/types MergedSettingsCategory） */
export type AppUiSettingsCategory =
  | 'general'
  | 'workspace'
  | 'modelConfig'
  | 'voice'
  | 'channels'
  | 'codingDev'
  | 'pet'
  | 'usage'
  | 'privacy'
  | 'aboutAndUpdate'

/** app_goto 工具入参 */
export interface GotoInput {
  view: AppUiViewType
  category?: AppUiSettingsCategory
}

/** app_act click 入参 */
export interface ActClickInput {
  action: 'click'
  ref: string
  snapshotId?: string
}

/** app_act type 入参 */
export interface ActTypeInput {
  action: 'type'
  ref: string
  text: string
  clear?: boolean
  snapshotId?: string
}

/** app_act key 入参（无需 ref，发往当前聚焦的 webContents） */
export interface ActKeyInput {
  action: 'key'
  key: string
  snapshotId?: string
}

/** app_act scroll 入参 */
export interface ActScrollInput {
  action: 'scroll'
  ref: string
  dx?: number
  dy?: number
  snapshotId?: string
}

/** app_act 工具入参 */
export type ActInput = ActClickInput | ActTypeInput | ActKeyInput | ActScrollInput

/** click 校验所需的快照上下文 */
export interface AppUiClickContext {
  snapshotId: string
  refs: AppUiRef[]
}
