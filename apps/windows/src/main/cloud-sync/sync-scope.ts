/**
 * 同步范围规则：排除（永不参与同步）与强制包含（无视阈值走阶段一）。
 *
 * 匹配器是**零依赖的极简 glob**（`**` 跨目录 / `*` 单层 / `?` 单字符）——
 * node_modules 里虽有 minimatch、picomatch，但它们未在 package.json 声明
 * （ghost dependency，随时可能因依赖提升策略变化而消失），不值得为此绑定。
 *
 * 路径基准统一为**相对于 outputs 目录**（如 `20260810/*.png`、`小星星绘本/**`），
 * 这是用户最容易写对的形式。
 */

/**
 * 极简 glob → 正则。
 *
 * `**\/` 匹配**零或多层**目录（`**‌/a.png` 也要命中根下的 `a.png`），
 * 这条最容易被写错成 `.*\/`（要求至少一层）。
 */
function globToRegExp(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i++
        if (pattern[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else {
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp(`^${re}$`)
}

/** 路径是否命中单条 glob 规则 */
export function matchGlob(pattern: string, filepath: string): boolean {
  if (!pattern) return false
  try {
    return globToRegExp(pattern).test(filepath)
  } catch {
    return false // 非法 pattern 一律不命中，绝不因规则写错而误伤
  }
}

export interface SyncScopeRules {
  exclude: readonly string[]
  forceInclude: readonly string[]
}

/** 空规则集（未配置时的默认） */
export const EMPTY_SCOPE_RULES: SyncScopeRules = { exclude: [], forceInclude: [] }

/**
 * 路径是否被排除。**排除优先于强制包含** —— 规则写冲突时以"不传"为准，
 * 这是更安全的失败方向。
 */
export function isExcluded(filepath: string, rules: SyncScopeRules): boolean {
  return rules.exclude.some((p) => matchGlob(p, filepath))
}

/** 路径是否被强制包含（且未被排除） */
export function isForceIncluded(filepath: string, rules: SyncScopeRules): boolean {
  if (isExcluded(filepath, rules)) return false
  return rules.forceInclude.some((p) => matchGlob(p, filepath))
}

/** 从配置字段构造规则集（字段缺失视为空） */
export function scopeRulesFromConfig(cfg: {
  syncExcludePatterns?: readonly string[]
  syncForceIncludePatterns?: readonly string[]
}): SyncScopeRules {
  return {
    exclude: cfg.syncExcludePatterns ?? [],
    forceInclude: cfg.syncForceIncludePatterns ?? [],
  }
}
