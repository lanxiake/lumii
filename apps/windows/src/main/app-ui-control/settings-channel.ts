/**
 * C 层：设置读写通道。
 *
 * 主进程无设置写路径，读写都通过 executeJavaScript 在渲染进程内完成。
 * 写操作的 merge 必须在注入脚本内部一次性完成，避免主进程先读、再 merge、
 * 再写期间用户在设置页点保存被覆盖（useSettings.saveSettings 是整对象覆盖式 setItem，
 * 没有版本号或 CAS）。
 */

/** 禁止经 CLI 写入的设置路径（防止自举开启 App UI 总开关） */
export const PROTECTED_SETTINGS_PATHS: readonly string[] = ['privacy.allowAgentAppUiControl']

/**
 * 将 `a.b.c` + value 展开为嵌套对象 patch。
 */
export function expandPathValue(keyPath: string, value: unknown): Record<string, unknown> {
  const parts = keyPath.split('.').filter(Boolean)
  if (parts.length === 0) return {}
  const root: Record<string, unknown> = {}
  let cur = root
  for (let i = 0; i < parts.length - 1; i++) {
    const next: Record<string, unknown> = {}
    cur[parts[i]!] = next
    cur = next
  }
  cur[parts[parts.length - 1]!] = value
  return root
}

/** 若 patch 触及受保护路径则拒绝 */
export function assertWritablePatch(
  patch: Record<string, unknown>,
): { ok: true } | { ok: false; error: 'field_protected' } {
  for (const path of PROTECTED_SETTINGS_PATHS) {
    const parts = path.split('.')
    let cur: unknown = patch
    let hit = true
    for (const p of parts) {
      if (cur == null || typeof cur !== 'object' || !(p in (cur as object))) {
        hit = false
        break
      }
      cur = (cur as Record<string, unknown>)[p]
    }
    if (hit) return { ok: false, error: 'field_protected' }
  }
  return { ok: true }
}

/**
 * 生成读 localStorage 的注入脚本；keyPath 省略时返回整份设置 JSON。
 */
export function buildReadScript(keyPath?: string): string {
  const keyLit = keyPath === undefined ? 'undefined' : JSON.stringify(keyPath)
  return `(() => {
    const getByPath = (obj, path) => {
      if (!path) return obj
      return path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), obj)
    }
    const current = JSON.parse(localStorage.getItem('mtbot-assistant-settings') || '{}')
    return JSON.stringify(getByPath(current, ${keyLit}))
  })()`
}

/**
 * 生成在渲染进程内原子完成「读-merge-写-广播」的注入脚本。
 * patch 经 JSON.stringify 后直接内嵌（已是合法 JS 字面量，禁止二次 stringify）。
 * deepMerge 语义对齐 useSettings.ts:91-112。
 */
export function buildPatchScript(patch: Record<string, unknown>): string {
  return `(() => {
    const KEY = 'mtbot-assistant-settings'
    const deepMerge = (t, s) => {
      const result = Object.assign({}, t)
      for (const key of Object.keys(s)) {
        const tv = t[key], sv = s[key]
        if (
          tv && typeof tv === 'object' && !Array.isArray(tv) &&
          sv && typeof sv === 'object' && !Array.isArray(sv)
        ) {
          result[key] = deepMerge(tv, sv)
        } else if (sv !== undefined) {
          result[key] = sv
        }
      }
      return result
    }
    const current = JSON.parse(localStorage.getItem(KEY) || '{}')
    const next = deepMerge(current, ${JSON.stringify(patch)})
    localStorage.setItem(KEY, JSON.stringify(next))
    window.dispatchEvent(new CustomEvent('mtbot-settings-update', { detail: next }))
    return JSON.stringify(next)
  })()`
}
