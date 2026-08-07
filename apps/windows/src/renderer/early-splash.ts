/**
 * 尽早启动开机画面：在 React 挂载前注入 DOM 并开始加载/播放视频。
 * 由 index.html 在 main.tsx 之前以 module 引入。
 */
import splashUrl from '@app-assets/splash.mp4'
import posterUrl from '@app-assets/splash-poster.jpg'

const EARLY_ID = 'lumii-early-splash'
const FG_ID = 'lumii-early-splash-fg'
const BG_ID = 'lumii-early-splash-bg'

/**
 * 是否应跳过开机画面（与 App.shouldSkipSplash 对齐）
 */
function shouldSkip(): boolean {
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
#${EARLY_ID}{position:fixed;inset:0;z-index:100000;display:grid;place-items:center;overflow:hidden;background:#070d18;-webkit-app-region:drag}
#${EARLY_ID} .lumii-es-bg{position:absolute;inset:-4%;width:108%;height:108%;object-fit:cover;filter:blur(28px) saturate(1.15) brightness(0.55);transform:scale(1.08);pointer-events:none}
#${EARLY_ID} .lumii-es-vignette{position:absolute;inset:0;background:radial-gradient(ellipse 70% 60% at 50% 45%,transparent 35%,rgba(7,13,24,.55) 100%),linear-gradient(90deg,rgba(7,13,24,.35) 0%,transparent 18%,transparent 82%,rgba(7,13,24,.35) 100%);pointer-events:none}
#${EARLY_ID} .lumii-es-fg{position:relative;z-index:1;width:min(100%,920px);height:min(100%,820px);max-width:100%;max-height:100%;object-fit:contain;box-shadow:0 0 0 1px color-mix(in srgb,#7dd3fc 18%,transparent),0 24px 80px rgba(0,0,0,.45);background:transparent;-webkit-app-region:no-drag}
#${EARLY_ID}.lumii-es-fading{opacity:0;pointer-events:none;transition:opacity .32s ease}
`
  document.head.appendChild(style)

  const root = document.createElement('div')
  root.id = EARLY_ID
  root.setAttribute('role', 'presentation')
  root.setAttribute('aria-label', '灵栖启动动画')
  root.innerHTML = `
    <video id="${BG_ID}" class="lumii-es-bg" src="${splashUrl}" poster="${posterUrl}" muted playsinline preload="auto" aria-hidden="true"></video>
    <div class="lumii-es-vignette" aria-hidden="true"></div>
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
