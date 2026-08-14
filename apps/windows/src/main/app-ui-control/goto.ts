import type { AppUiSettingsCategory, AppUiViewType, GotoInput } from './types'

/** 合法 ViewType 集合（对齐 Router.tsx） */
const VALID_VIEWS: ReadonlySet<string> = new Set<AppUiViewType>([
  'dashboard',
  'chat',
  'skills',
  'settings',
  'memories',
  'agents',
  'cron',
  'plugins',
  'mcp',
])

/** 合法 MergedSettingsCategory 集合（对齐 SettingsHub/types.ts） */
const VALID_CATEGORIES: ReadonlySet<string> = new Set<AppUiSettingsCategory>([
  'general',
  'workspace',
  'modelConfig',
  'voice',
  'channels',
  'codingDev',
  'pet',
  'usage',
  'privacy',
  'aboutAndUpdate',
])

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

  if (typeof view !== 'string' || !VALID_VIEWS.has(view)) {
    return { ok: false, error: 'usage' }
  }

  const category = params.category
  if (category !== undefined) {
    if (typeof category !== 'string' || !VALID_CATEGORIES.has(category)) {
      return { ok: false, error: 'usage' }
    }
    return {
      ok: true,
      input: { view: view as AppUiViewType, category: category as AppUiSettingsCategory },
    }
  }

  return { ok: true, input: { view: view as AppUiViewType } }
}
