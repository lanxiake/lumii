/**
 * 右栏面板可用的呈现模式（唯一真相源）。
 *
 * 工具 schema、渲染层校验、错误码提示都从这里衍生 —— 散在三处必然会漂移。
 * **不开放给插件**：面板是宿主能力，`AppPanelMode` 与 `WorkbenchTab` 都是内置联合类型。
 */

export const APP_PANEL_MODES = ['doc'] as const
export type AppPanelMode = (typeof APP_PANEL_MODES)[number]

/** 每个模式写给模型看的用途说明（也是唯一的文档来源） */
export const APP_PANEL_MODE_HINTS: Record<AppPanelMode, string> = {
  doc: '可翻可改的 markdown 稿件。用户说"打开这篇/改这段/通读一遍"时用。',
}

/** 一次面板打开请求（主进程 → 渲染层的载荷形状） */
export interface AppPanelRequest {
  mode: AppPanelMode
  /** 打开什么：工作区相对路径或绝对路径 */
  path?: string
}

export function isAppPanelMode(v: unknown): v is AppPanelMode {
  return typeof v === 'string' && (APP_PANEL_MODES as readonly string[]).includes(v)
}
