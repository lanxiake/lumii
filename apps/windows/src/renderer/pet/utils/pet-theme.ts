/**
 * pet-theme — 宠物窗的主题跟随（**只读**）
 *
 * ## 为什么宠物窗自己读，而不是主进程广播
 *
 * 主题**只活在主窗渲染进程的 localStorage 里**（`mtbot-assistant-settings` 的
 * `theme.mode`，以及独立 key `mtbot_theme`），主进程根本不知道它 —— `shared/` 与
 * `main/` 里没有任何主题字段，也就没有可转发的源。而宠物窗与主窗**同源、同 partition、
 * 共用同一份 localStorage**（`pet-window-manager.ts` 建窗时没给 `partition`），
 * 数据本来就在手边，缺的只是"读一次 + 订阅变化"。
 *
 * ## 为什么这是对"宠物层不跟主题"的一次定向推翻
 *
 * `docs/plans/代码重构/客户端切片/07-主题色系/12-canvas与宠物色层收敛.md` §3.2 / §六
 * 当年的判断：宠物是独立透明浮层，用户用深色主题工作时，桌面宠物不该突然变成米黄色。
 * 那个判断针对的是**整个宠物层**（坞、粒子、调试 HUD）。
 *
 * 用户实测反馈之后，本模块**只服务气泡**：气泡的底色与文字色跟随主题。坞与粒子继续用
 * 各自的常量 —— 它们不读令牌，所以设 `data-theme` 对它们**零影响**（`pet/` 目录里
 * `var(--mt-` 的引用在本模块之前是 0 处；这一点是有意维持的，别"顺手"扩散）。
 *
 * ⚠️ **只读，绝不写回**。`ThemeContext.setTheme` 会把主题 persist 进共享的 localStorage
 * 并派发同 document 的自定义事件 —— 从宠物窗调它等于**反向污染主窗设置**。
 *
 * ## 实时跟随靠 `storage` 事件（已实测）
 *
 * `persistTheme` 只做两件事：写 localStorage、在主窗自己 `dispatchEvent`
 * （同 document，跨窗无效）。浏览器对**其他**同源 document 派发 `storage` 事件，
 * 这是唯一的实时通道。另订阅 `prefers-color-scheme` 以覆盖 `mode === 'system'`
 * （本窗口的媒体查询与主窗同值，但主窗计算出的 appliedTheme 不会被广播过来）。
 */

/** 实际落到 DOM 上的三档（`system` 已被解析掉） */
export type PetAppliedTheme = 'light' | 'dark' | 'eye-care'

/** 设置里可能写着的四档（含跟随系统） */
export type PetThemeMode = PetAppliedTheme | 'system'

const THEME_KEY = 'mtbot_theme'
const SETTINGS_KEY = 'mtbot-assistant-settings'

/** 与 `ThemeContext.tsx` 的 `THEME_VALUES` 同一张表（那边是渲染层私有常量，不导出） */
function isThemeMode(value: unknown): value is PetThemeMode {
  return value === 'light' || value === 'dark' || value === 'eye-care' || value === 'system'
}

export function isAppliedTheme(value: unknown): value is PetAppliedTheme {
  return value === 'light' || value === 'dark' || value === 'eye-care'
}

/** `system` → 实际主题。抽成纯函数是为了能脱开 `matchMedia` 单测 */
export function resolveSystemTheme(prefersDark: boolean): PetAppliedTheme {
  return prefersDark ? 'dark' : 'light'
}

/**
 * 从 localStorage 的两份原始字符串解析出**实际生效**的主题。
 *
 * 取值顺序与 `ThemeContext.loadTheme()` **逐条对齐**（settings 优先、独立 key 次之、
 * 兜底跟随系统）——两边不一致的话，宠物窗会和主窗显示成两个主题，而且不会报错。
 */
export function resolvePetTheme(
  rawSettings: string | null,
  rawTheme: string | null,
  prefersDark: boolean,
): PetAppliedTheme {
  let mode: unknown = null
  if (rawSettings) {
    try {
      mode = (JSON.parse(rawSettings) as { theme?: { mode?: unknown } } | null)?.theme?.mode ?? null
    } catch {
      // 内容损坏（写到一半 / 手改过）—— 继续往下试独立 key，不抛
    }
  }
  if (!isThemeMode(mode)) mode = rawTheme
  if (!isThemeMode(mode)) return resolveSystemTheme(prefersDark)
  return mode === 'system' ? resolveSystemTheme(prefersDark) : mode
}

/** 读一次当前主题。存储不可用（隐私模式 / 被禁用）时退回跟随系统 */
export function readPetTheme(): PetAppliedTheme {
  let rawSettings: string | null = null
  let rawTheme: string | null = null
  try {
    rawSettings = localStorage.getItem(SETTINGS_KEY)
    rawTheme = localStorage.getItem(THEME_KEY)
  } catch {
    // localStorage 抛错在生产里真会发生（禁用第三方存储等），不该让宠物窗白屏
  }
  const prefersDark =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false
  return resolvePetTheme(rawSettings, rawTheme, prefersDark)
}

/**
 * 写到 `<html>` 上（与主窗 `applyThemeToDOM` 同位置）。
 *
 * 写在 `documentElement` 而不是气泡自己的容器上：气泡用的是 `--mt-*` 令牌，挂在任意
 * 祖先都能生效；但主窗的映射层（`--color-*: var(--mt-*)`）声明在 `:root` 且**在声明处
 * 解析**，将来若有人想在宠物窗用映射层，只有 `documentElement` 上这一份能让它重算。
 * 与主窗保持同一个位置，省掉一次"为什么这里不一样"。
 */
export function applyPetTheme(theme: PetAppliedTheme): void {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', theme)
}

/**
 * 订阅主题变化，返回取消订阅函数。
 *
 * 去重靠比较解析后的**实际主题**：主窗每写一次 settings 都会触发 `storage`
 * （而 settings 被写得很频繁），不去重会把同一个主题反复 apply。
 */
export function subscribePetTheme(onChange: (theme: PetAppliedTheme) => void): () => void {
  let last = readPetTheme()
  const push = (): void => {
    const next = readPetTheme()
    if (next === last) return
    last = next
    onChange(next)
  }
  window.addEventListener('storage', push)
  const mediaQuery =
    typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null
  mediaQuery?.addEventListener?.('change', push)
  return () => {
    window.removeEventListener('storage', push)
    mediaQuery?.removeEventListener?.('change', push)
  }
}
