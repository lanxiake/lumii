/**
 * 尽早启动开机画面：在 React 挂载前注入 DOM 并开始加载/播放视频。
 * 由 index.html 在 main.tsx 之前以 module 引入。
 *
 * 注意：本文件不可依赖 React / App，仅用同步可读的 URL / localStorage / preload。
 */
import splashUrl from '@app-assets/splash.mp4'
import posterUrl from '@app-assets/splash-poster.jpg'

const EARLY_ID = 'lumii-early-splash'
const FG_ID = 'lumii-early-splash-fg'
const BG_ID = 'lumii-early-splash-bg'
const SETTINGS_STORAGE_KEY = 'mtbot-assistant-settings'

/**
 * 辅助窗口（文件预览 / 宠物）不播放开机动画
 */
function isAuxiliaryWindowMode(): boolean {
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
 * 设置中关闭开机动画时跳过（默认开启）
 */
function isSplashDisabledInSettings(): boolean {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw) as { system?: { showSplashOnStartup?: boolean } }
    return parsed?.system?.showSplashOnStartup === false
  } catch {
    return false
  }
}

/**
 * 是否应跳过开机画面（与 App.shouldSkipSplash 对齐）
 */
function shouldSkip(): boolean {
  if (isAuxiliaryWindowMode()) return true
  if (isSplashDisabledInSettings()) return true
  try {
    if (sessionStorage.getItem('lumii.splash.done') === '1') return true
  } catch {
    // ignore
  }
  try {
    return Boolean(window.electronAPI?.splash?.shouldSkip?.())
  } catch {
    return false
  }
}

/**
 * 注入早期 Splash DOM 并尝试播放
 */
function mountEarlySplash(): void {
  if (shouldSkip()) return
  if (document.getElementById(EARLY_ID)) return

  const style = document.createElement('style')
  style.textContent = `
#${EARLY_ID}{position:fixed;inset:0;z-index:100000;display:grid;place-items:center;overflow:hidden;background:radial-gradient(ellipse 85% 70% at 50% 42%,#f7fbff 0%,#e8f2fa 55%,#d9e8f4 100%);-webkit-app-region:drag}
#${EARLY_ID} .lumii-es-bg{position:absolute;inset:-6%;width:112%;height:112%;object-fit:cover;filter:blur(42px) saturate(1.08) brightness(1.08) contrast(.92);transform:scale(1.12);opacity:.92;pointer-events:none}
#${EARLY_ID} .lumii-es-vignette{position:absolute;inset:0;background:radial-gradient(ellipse 75% 65% at 50% 45%,rgba(247,251,255,.15) 20%,rgba(217,232,244,.35) 70%,rgba(196,220,236,.55) 100%),linear-gradient(90deg,rgba(214,230,242,.55) 0%,transparent 22%,transparent 78%,rgba(214,230,242,.55) 100%);pointer-events:none}
#${EARLY_ID} .lumii-es-glow{position:absolute;inset:0;background:linear-gradient(105deg,color-mix(in srgb,#9fd0f0 28%,transparent) 0%,transparent 30%,transparent 70%,color-mix(in srgb,#b8d4f0 22%,transparent) 100%);opacity:.65;pointer-events:none}
#${EARLY_ID} .lumii-es-fg{position:relative;z-index:1;width:min(100%,920px);height:min(100%,820px);max-width:100%;max-height:100%;object-fit:contain;box-shadow:0 0 0 1px color-mix(in srgb,#8ec5e8 22%,transparent),0 18px 56px rgba(120,160,190,.22);background:transparent;-webkit-app-region:no-drag}
#${EARLY_ID}.lumii-es-fading{opacity:0;pointer-events:none;transition:opacity .55s ease}
`
  document.head.appendChild(style)

  const root = document.createElement('div')
  root.id = EARLY_ID
  root.setAttribute('role', 'presentation')
  root.setAttribute('aria-label', '灵栖启动动画')
  root.innerHTML = `
    <video id="${BG_ID}" class="lumii-es-bg" src="${splashUrl}" poster="${posterUrl}" muted playsinline preload="auto" aria-hidden="true"></video>
    <div class="lumii-es-vignette" aria-hidden="true"></div>
    <div class="lumii-es-glow" aria-hidden="true"></div>
    <video id="${FG_ID}" class="lumii-es-fg" src="${splashUrl}" poster="${posterUrl}" autoplay playsinline preload="auto"></video>
  `
  document.body.appendChild(root)

  const fg = document.getElementById(FG_ID) as HTMLVideoElement | null
  const bg = document.getElementById(BG_ID) as HTMLVideoElement | null
  if (!fg) return

  const syncBg = () => {
    if (!bg) return
    try {
      if (Math.abs(bg.currentTime - fg.currentTime) > 0.12) {
        bg.currentTime = fg.currentTime
      }
    } catch {
      // ignore
    }
  }

  fg.addEventListener('timeupdate', syncBg)

  void (async () => {
    try {
      await fg.play()
    } catch {
      fg.muted = true
      if (bg) bg.muted = true
      try {
        await fg.play()
      } catch {
        // SplashOverlay 会处理失败 fallback
      }
    }
    if (bg) {
      bg.muted = true
      void bg.play().catch(() => undefined)
      syncBg()
    }
  })()
}

mountEarlySplash()

export { EARLY_ID, FG_ID, BG_ID }
