/**
 * SplashOverlay — 主窗口内全屏开机画面
 *
 * 优先接管 index.html 引入的 early-splash（已在 React 前开始播放）；
 * 若不存在则自行挂载双层 video + 海报，避免首帧前纯黑屏。
 *
 * 结束时：先等主壳就绪信号，再较长淡出，并释放视频解码资源，减轻进入主页时的卡顿。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import splashUrl from '@app-assets/splash.mp4'
import posterUrl from '@app-assets/splash-poster.jpg'
import { EARLY_ID, FG_ID, BG_ID } from '../../early-splash'
import { markSplashPlayedThisSession } from '../../utils/splash-preference'
import styles from './SplashOverlay.module.css'

export interface SplashOverlayProps {
  /** 播放结束（或跳过/出错）后回调 */
  onDone: () => void
  /**
   * 可选：主界面已可展示时 resolve。
   * 视频播完后若主壳尚未就绪，会停在最后一帧等待，避免揭开后几秒卡顿。
   */
  waitForReady?: () => Promise<void>
}

const FALLBACK_MS = 12_000
/** 淡出时长（与 CSS / early-splash 一致） */
const FADE_MS = 550
/** 主壳就绪后额外稳定一帧，再开始淡出 */
const SETTLE_MS = 120

/**
 * 释放 video 元素解码资源，降低揭开主 UI 时的争用
 */
function releaseVideo(el: HTMLVideoElement | null): void {
  if (!el) return
  try {
    el.pause()
    el.removeAttribute('src')
    el.load()
  } catch {
    // ignore
  }
}

/**
 * 等两帧 rAF，确保底层 UI 已提交绘制
 */
function waitTwoFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve())
    })
  })
}

/**
 * 淡出并移除早期 Splash DOM
 */
function fadeOutEarlySplash(el: HTMLElement, onComplete: () => void): void {
  el.classList.add('lumii-es-fading')
  window.setTimeout(() => {
    el.remove()
    onComplete()
  }, FADE_MS)
}

/**
 * 主窗口内全屏播放开机动画
 */
export const SplashOverlay: React.FC<SplashOverlayProps> = ({ onDone, waitForReady }) => {
  const fgRef = useRef<HTMLVideoElement>(null)
  const bgRef = useRef<HTMLVideoElement>(null)
  const doneRef = useRef(false)
  const [fading, setFading] = useState(false)
  /** 是否由 React 自己渲染视频（early splash 不存在时） */
  const [useReactVideo, setUseReactVideo] = useState(false)

  const finish = useCallback(async () => {
    if (doneRef.current) return
    doneRef.current = true
    markSplashPlayedThisSession()

    try {
      if (waitForReady) {
        await Promise.race([
          waitForReady(),
          new Promise<void>((r) => window.setTimeout(r, 4000)),
        ])
      }
    } catch {
      // 就绪等待失败不阻塞退出 splash
    }

    await waitTwoFrames()
    await new Promise<void>((r) => window.setTimeout(r, SETTLE_MS))

    const early = document.getElementById(EARLY_ID)
    const earlyFg = document.getElementById(FG_ID) as HTMLVideoElement | null
    const earlyBg = document.getElementById(BG_ID) as HTMLVideoElement | null
    releaseVideo(earlyFg)
    releaseVideo(earlyBg)
    releaseVideo(fgRef.current)
    releaseVideo(bgRef.current)

    if (early) {
      fadeOutEarlySplash(early, onDone)
      return
    }

    setFading(true)
    window.setTimeout(() => onDone(), FADE_MS)
  }, [onDone, waitForReady])

  // 接管 early splash 或回退到 React 自管视频
  useEffect(() => {
    const early = document.getElementById(EARLY_ID)
    const earlyFg = document.getElementById(FG_ID) as HTMLVideoElement | null

    if (early && earlyFg) {
      const onEnded = () => {
        void finish()
      }
      const onError = () => {
        void finish()
      }
      earlyFg.addEventListener('ended', onEnded)
      earlyFg.addEventListener('error', onError)

      // 若 early 已播完（React 挂载偏晚），等主壳就绪后再淡出，避免瞬间揭开卡顿
      if (earlyFg.ended || earlyFg.error) {
        void finish()
      }

      const fallback = window.setTimeout(() => {
        void finish()
      }, FALLBACK_MS)
      return () => {
        earlyFg.removeEventListener('ended', onEnded)
        earlyFg.removeEventListener('error', onError)
        window.clearTimeout(fallback)
      }
    }

    setUseReactVideo(true)
  }, [finish])

  // React 自管视频播放
  useEffect(() => {
    if (!useReactVideo) return
    const fg = fgRef.current
    const bg = bgRef.current
    if (!fg) return

    const syncBg = () => {
      if (!bg) return
      try {
        if (Math.abs(bg.currentTime - fg.currentTime) > 0.12) {
          bg.currentTime = fg.currentTime
        }
      } catch {
        // seek 失败忽略
      }
    }

    const onEnded = () => {
      void finish()
    }
    const onError = () => {
      void finish()
    }
    const onTimeUpdate = () => syncBg()

    fg.addEventListener('ended', onEnded)
    fg.addEventListener('error', onError)
    fg.addEventListener('timeupdate', onTimeUpdate)

    const playBoth = async () => {
      try {
        await fg.play()
      } catch {
        fg.muted = true
        if (bg) bg.muted = true
        try {
          await fg.play()
        } catch {
          void finish()
          return
        }
      }
      if (bg) {
        bg.muted = true
        void bg.play().catch(() => undefined)
        syncBg()
      }
    }
    void playBoth()

    const fallback = window.setTimeout(() => {
      void finish()
    }, FALLBACK_MS)
    return () => {
      fg.removeEventListener('ended', onEnded)
      fg.removeEventListener('error', onError)
      fg.removeEventListener('timeupdate', onTimeUpdate)
      window.clearTimeout(fallback)
    }
  }, [finish, useReactVideo])

  // early splash 已存在时不额外盖一层，避免双重视频
  if (!useReactVideo) {
    return null
  }

  return (
    <div
      className={`${styles.overlay} ${fading ? styles.fading : ''}`}
      role="presentation"
      aria-label="灵栖启动动画"
    >
      <video
        ref={bgRef}
        className={styles.bgVideo}
        src={splashUrl}
        poster={posterUrl}
        muted
        playsInline
        preload="auto"
        aria-hidden="true"
      />
      <div className={styles.vignette} aria-hidden="true" />
      <div className={styles.sideGlow} aria-hidden="true" />
      <video
        ref={fgRef}
        className={styles.fgVideo}
        src={splashUrl}
        poster={posterUrl}
        autoPlay
        playsInline
        preload="auto"
      />
    </div>
  )
}

export default SplashOverlay
