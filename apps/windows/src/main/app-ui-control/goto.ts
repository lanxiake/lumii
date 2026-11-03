import type { AppUiSettingsCategory, AppUiViewType, GotoInput } from './types'

/** 合法 ViewType 集合（对齐 Router.tsx） */
const VALID_VIEWS: ReadonlySet<string> = new Set<AppUiViewType>([
  'dashboard',
  'chat',
  'autonomous',
  'skills',
  'settings',
  'memories',
  'wiki',
  'agents',
  'cron',
  'plugins',
  'mcp',
])

/** 合法 MergedSettingsCategory 集合（对齐 SettingsHub/types.ts） */
const VALID_CATEGORIES: ReadonlySet<string> = new Set<AppUiSettingsCategory>([
  'general',
  'appearance',
  'workspace',
  'storage',
  'modelConfig',
  'voice',
  'channels',
  'codingDev',
  'pet',
  'usage',
  'privacy',
  'cloudSync',
  'screenRecord',
  'experimental',
  'aboutAndUpdate',
])

/**
 * 插件页寻址：`plugin:<viewId>`（与 Router.tsx 的 `plugin:${string}` 同形）。
 *
 * 白名单里没有它，`app_goto` 就到不了任何插件页——而侧栏能点到，说明这不是"不支持"，
 * 只是校验没跟上。2026-11-03 真机：`feature-demo-video` 第 4 步
 * `app_goto {view:"plugin:pipeline"}` 返回 `{"ok":false,"error":"usage"}`，
 * 整条录制因此失败（前 3 步全绿）。
 *
 * 用**形状**而不是枚举：插件是动态的（用户装/停用随时变），把 26 个内置插件的 id
 * 抄进白名单等于再造一份会漂移的清单。路由那侧本来就不认白名单，未知 id 会落到
 * 「插件页不存在」的空态，比静默拒绝好诊断。
 */
const PLUGIN_VIEW_PATTERN = /^plugin:[A-Za-z0-9_-]+$/

function isValidView(view: string): view is AppUiViewType | `plugin:${string}` {
  return VALID_VIEWS.has(view) || PLUGIN_VIEW_PATTERN.test(view)
}

export type ParseGotoInputResult =
  | { ok: true; input: GotoInput }
  | { ok: false; error: 'usage' }

/**
 * 解析并校验 app_goto 入参：合法 ViewType + 可选 MergedSettingsCategory。
 */
export function parseGotoInput(raw: unknown): ParseGotoInputResult {
  if (raw == null || typeof raw !== 'object') {
    return { ok: false, error: 'usage' }
  }

  const params = raw as Record<string, unknown>
  const view = params.view

  if (typeof view !== 'string' || !isValidView(view)) {
    return { ok: false, error: 'usage' }
  }

  const category = params.category
  if (category !== undefined) {
    if (typeof category !== 'string' || !VALID_CATEGORIES.has(category)) {
      return { ok: false, error: 'usage' }
    }
    return {
      ok: true,
      input: { view, category: category as AppUiSettingsCategory } as GotoInput,
    }
  }

  return { ok: true, input: { view } as GotoInput }
}
