/**
 * 尽早启动开机画面：在 React 挂载前注入 DOM 并开始绘制。
 * 由 index.html 在 main.tsx 之前以 module 引入。
 *
 * 视觉层是 HTML 渲染（Canvas 粒子 + CSS 网格/光环），不再等视频解码，首帧即可出画面。
 * 细节见 `boot/boot-visual.ts`。
 *
 * 注意：本文件不可依赖 React / App，仅用同步可读的 localStorage / preload。
 */
import { audioCueForProgress } from './boot/boot-climax'
import { BOOT_ID, mountBootVisual, type BootVisualHandle, type BootProgress } from './boot/boot-visual'
import { createBootAudio, type BootAudioHandle } from './boot/boot-audio'
import { hasSplashPlayedThisSession } from './utils/splash-preference'

/** 与 boot-visual 实际挂载的节点 id 一致；两边不同会让「是否已挂载」的判断永远落空 */
const EARLY_ID = BOOT_ID
const SETTINGS_STORAGE_KEY = 'mtbot-assistant-settings'

/**
 * 进度总线。
 *
 * 广播可能在订阅建立前就到达（主进程比渲染层早），所以到过的事件要留存补发；
 * 同时视觉层与音效层都要听，用一个集合统一分发，避免各订各的漏掉一条。
 */
const history: BootProgress[] = []
const listeners = new Set<(p: BootProgress) => void>()

function publish(p: BootProgress): void {
  history.push(p)
  for (const listener of listeners) listener(p)
}

let visual: BootVisualHandle | null = null
let audio: BootAudioHandle | null = null
let offProgress: (() => void) | null = null
let watchdogTimer = 0

/**
 * 看门狗时限。主壳正常几百毫秒就绪，SplashOverlay 也会等主壳最多 8s；
 * 12s 足够覆盖慢机器，又不至于让人对着覆盖层干等半分钟。
 */
const WATCHDOG_MS = 12_000

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

function readSystemSettings(): { showSplashOnStartup?: boolean; splashSound?: boolean } {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as {
      system?: { showSplashOnStartup?: boolean; splashSound?: boolean }
    }
    return parsed?.system ?? {}
  } catch {
    return {}
  }
}

/**
 * 是否应跳过开机画面（辅助窗 / 设置关闭 / 静默启动 / 本会话已播）
 *
 * 最后一条不能省：页面重载（崩溃恢复 / HMR / F5）时 sessionStorage 仍在，
 * App 侧的 SplashOverlay 会因为「已播过」而不渲染。若这里还照挂，
 * 就再没有代码去调 `complete()` —— 覆盖层永远盖在主界面上，看起来就是开机卡死。
 */
function shouldSkip(): boolean {
  if (isAuxiliaryWindowMode()) {
    console.info('[early-splash] 跳过：辅助窗口模式')
    return true
  }
  if (readSystemSettings().showSplashOnStartup === false) {
    console.info('[early-splash] 跳过：设置里关闭了开机动画')
    return true
  }
  try {
    if (hasSplashPlayedThisSession()) {
      console.info('[early-splash] 跳过：本会话已播过（页面重载）')
      return true
    }
  } catch {
    // ignore
  }
  try {
    if (window.electronAPI?.splash?.shouldSkip?.()) {
      console.info('[early-splash] 跳过：主进程要求静默启动')
      return true
    }
  } catch {
    // ignore
  }
  return false
}

function mountEarlySplash(): void {
  if (shouldSkip()) return
  if (document.getElementById(EARLY_ID)) {
    console.info('[early-splash] 跳过：节点已存在')
    return
  }

  console.info('[early-splash] 正在挂载开机画面')

  const soundEnabled = readSystemSettings().splashSound !== false

  // 挂载失败不能让启动流程跟着挂：开机画面是装饰，
  // 但它抛错会在 React 之前静默中止，表现就是「一直黑屏」且没有日志。
  try {
    visual = mountBootVisual({
      subscribe: (cb) => {
        listeners.add(cb)
        // 订阅前已到达的阶段补发，否则首屏看不到前几行
        for (const p of history) cb(p)
        return () => listeners.delete(cb)
      },
      // audio 可能稍后才创建；调用时再读，挂载失败也不会先开底噪
      onStall: (stalled) => audio?.setStalled(stalled),
      onClimax: (kind) => {
        if (kind === 'gate-seam') audio?.gateOpen()
        if (kind === 'logo-land') audio?.logoLand()
        // cognition-enter 由阶段 pulse/climaxPulse 覆盖，这里不叠第二声
      },
    })
    console.info('[early-splash] 已挂载，节点数=', document.querySelectorAll(`#${EARLY_ID}`).length)
  } catch (err) {
    console.error('[early-splash] 挂载失败：', err)
    return
  }

  if (soundEnabled) {
    try {
      audio = createBootAudio()
      let lastPhase = ''
      // 视觉订阅先入 listeners，解卡时会先 applyStall(false) 再轮到 pulse
      listeners.add((p) => {
        if (p.phase === lastPhase) return
        lastPhase = p.phase
        const cue = audioCueForProgress(p.index, p.total)
        if (cue === 'climax') audio?.climaxPulse()
        else if (cue === 'pulse') audio?.pulse()
      })
    } catch (err) {
      // 音频不是必需品：自动播放策略可能直接拒绝创建 AudioContext
      console.warn('[early-splash] 音效初始化失败，静音继续：', err)
    }
  }

  try {
    offProgress = window.electronAPI?.splash?.onProgress?.(publish) ?? null
  } catch {
    // 订阅失败：视觉层用兜底曲线走完，不影响进入首页
  }

  /**
   * 看门狗：正常情况下由 App 里的 SplashOverlay 调 `complete()` 收尾。
   * 但界面层若在挂载前就抛错（插件、Provider、渲染异常），没人会来收，
   * 覆盖层就会永久盖住主界面 —— 用户看到的正是「开机动画卡住」。
   * 到这里自行退场，宁可少一点收尾动画，也不能把应用挡在外面。
   */
  watchdogTimer = window.setTimeout(() => {
    watchdogTimer = 0
    if (!visual) return
    console.warn('[early-splash] 超时未见收尾请求，强制退场')
    void visual.complete().catch(() => {
      try {
        document.getElementById(EARLY_ID)?.remove()
      } catch {
        // ignore
      }
    })
  }, WATCHDOG_MS)

  /**
   * 主动拉一次历史阶段。
   *
   * 启动的绝大多数阶段都在窗口加载页面之前就发完了，广播一条也收不到；
   * 不补这一步，开机动画显示的就是纯时间曲线编出来的假进度。
   */
  void (async () => {
    try {
      const res = await window.electronAPI?.splash?.history?.()
      if (!res?.phases?.length) return
      for (const p of res.phases) publish(p)
      console.info('[early-splash] 已补发历史阶段', res.phases.length, '条')
    } catch (err) {
      console.warn('[early-splash] 拉取历史阶段失败：', err)
    }
  })()
}

export function getBootVisual(): BootVisualHandle | null {
  return visual
}

export function getBootAudio(): BootAudioHandle | null {
  return audio
}

/** 开机画面结束后释放引用，避免残留句柄被下一次挂载复用 */
export function releaseBootVisual(): void {
  window.clearTimeout(watchdogTimer)
  watchdogTimer = 0
  offProgress?.()
  offProgress = null
  listeners.clear()
  visual = null
  audio = null
}

/** 测试用：重置模块状态 */
export function _resetEarlySplashForTest(): void {
  history.length = 0
  releaseBootVisual()
}

export { EARLY_ID }

mountEarlySplash()
