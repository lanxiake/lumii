/**
 * splash-preference — 开机动画是否播放（渲染进程同步可读）
 *
 * early-splash / App / SplashOverlay 共用，避免各处逻辑分叉。
 * 注意：勿依赖 React hooks 模块，以便与 early-splash 语义对齐且无循环依赖。
 */

/** 与 useSettings.SETTINGS_STORAGE_KEY 保持一致 */
const SETTINGS_STORAGE_KEY = 'mtbot-assistant-settings'
const SPLASH_DONE_KEY = 'lumii.splash.done'

/**
 * 当前窗口是否为非主壳模式（宠物 / 文件预览等），一律跳过开机动画
 */
export function isAuxiliaryWindowMode(): boolean {
  try {
    const search = new URLSearchParams(window.location.search)
    const hash = new URLSearchParams(window.location.hash.replace(/^#\??/, ''))
    const mode = search.get('mode') || hash.get('mode')
    return mode === 'file-preview' || mode === 'pet'
  } catch {
    return false
  }
}

/**
 * 用户是否在设置中关闭了开机动画（默认开启）
 */
export function isSplashDisabledInSettings(): boolean {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw) as { system?: { showSplashOnStartup?: boolean } }
    // 缺省为 true：仅显式 false 时关闭
    return parsed?.system?.showSplashOnStartup === false
  } catch {
    return false
  }
}

/**
 * 本会话是否已播完开机动画
 */
export function hasSplashPlayedThisSession(): boolean {
  try {
    return sessionStorage.getItem(SPLASH_DONE_KEY) === '1'
  } catch {
    return false
  }
}

/**
 * 标记本会话已播过开机动画
 */
export function markSplashPlayedThisSession(): void {
  try {
    sessionStorage.setItem(SPLASH_DONE_KEY, '1')
  } catch {
    // ignore
  }
}

/**
 * 是否应跳过开机画面（设置关闭 / 辅助窗 / 托盘静默 / 本会话已播）
 */
export function shouldSkipSplash(): boolean {
  if (typeof window === 'undefined') return true
  if (isAuxiliaryWindowMode()) return true
  if (isSplashDisabledInSettings()) return true
  if (hasSplashPlayedThisSession()) return true
  try {
    const skip = window.electronAPI?.splash?.shouldSkip?.()
    return Boolean(skip)
  } catch {
    return false
  }
}

/**
 * 移除 early-splash DOM（若仍存在）
 */
export function removeEarlySplashIfPresent(): void {
  try {
    document.getElementById('lumii-early-splash')?.remove()
  } catch {
    // ignore
  }
}
