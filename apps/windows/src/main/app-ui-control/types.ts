/**
 * Agent 界面控制：快照与视图相关的共享类型（Part A「看」所需）。
 */

/** 下拉框选项摘要（快照中随 combobox 一起回传） */
export interface AppUiRefOption {
  value: string
  label: string
}

/** 截图快照中可点击/可引用的 UI 元素 */
export interface AppUiRef {
  ref: string
  role: string
  name: string
  x: number
  y: number
  w: number
  h: number
  /** 输入框/下拉框的当前值；password 字段脱敏为 *** */
  value?: string
  /** 输入框的 placeholder，与 value 区分开，避免把占位符误当成已填内容 */
  placeholder?: string
  /** 原生下拉框的全部可选项，供 app_act select 直接选中 */
  options?: AppUiRefOption[]
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
  /** 中心点被弹层/遮罩挡住，点了也点不到 */
  occluded?: boolean
  /** 位于 role=dialog / aria-modal 弹层内，优先展示 */
  inDialog?: boolean
  /** 输入框/下拉框当前值；password 已脱敏 */
  value?: string
  /** 输入框 placeholder */
  placeholder?: string
  /** 原生下拉框可选项 */
  options?: AppUiRefOption[]
}

/** filterSnapshotNodes 的返回结构 */
export interface FilterSnapshotResult {
  refs: AppUiRef[]
  truncated: boolean
}

/** filterSnapshotNodes 可选参数 */
export interface FilterSnapshotOptions {
  /** 最大保留节点数，默认 DEFAULT_SNAPSHOT_NODE_LIMIT */
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

/** app_act type 入参（默认整体替换；append=true 时追加） */
export interface ActTypeInput {
  action: 'type'
  ref: string
  text: string
  /** 追加到原内容末尾，默认 false（整体替换） */
  append?: boolean
  /** 兼容旧参数：默认行为已是先清空再写入，传与不传等价 */
  clear?: boolean
  snapshotId?: string
}

/** app_act select 入参：按 value 或可读文案选中原生下拉框选项 */
export interface ActSelectInput {
  action: 'select'
  ref: string
  value?: string
  label?: string
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
export type ActInput =
  | ActClickInput
  | ActTypeInput
  | ActKeyInput
  | ActScrollInput
  | ActSelectInput

/** click 校验所需的快照上下文 */
export interface AppUiClickContext {
  snapshotId: string
  refs: AppUiRef[]
}
