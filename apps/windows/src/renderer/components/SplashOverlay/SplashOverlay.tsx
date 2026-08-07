/**
 * SplashOverlay — 主窗口内全屏开机画面
 *
 * 优先接管 index.html 引入的 early-splash（已在 React 前开始播放）；
 * 若不存在则自行挂载双层 video + 海报，避免首帧前纯黑屏。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import splashUrl from '@app-assets/splash.mp4'
import posterUrl from '@app-assets/splash-poster.jpg'
import { EARLY_ID, FG_ID } from '../../early-splash'
import styles from './SplashOverlay.module.css'

export interface SplashOverlayProps {
  /** 播放结束（或跳过/出错）后回调 */
  onDone: () => void
}

const FALLBACK_MS = 12_000

/**
 * 标记本会话已播过开机画面
 */
function markSplashDone(): void {
  try {
    sessionStorage.setItem('lumii.splash.done', '1')
  } catch {
    // ignore
  }
}

/**
 * 淡出并移除早期 Splash DOM
 */
function fadeOutEarlySplash(el: HTMLElement, onComplete: () => void): void {
  el.classList.add('lumii-es-fading')
  window.setTimeout(() => {
    el.remove()
    onComplete()
  }, 320)
}

/**
 * 主窗口内全屏播放开机动画
 */
export const SplashOverlay: React.FC<SplashOverlayProps> = ({ onDone }) => {
  const fgRef = useRef<HTMLVideoElement>(null)
  const bgRef = useRef<HTMLVideoElement>(null)
  const doneRef = useRef(false)
  const [fading, setFading] = useState(false)
  /** 是否由 React 自己渲染视频（early splash 不存在时） */
  const [useReactVideo, setUseReactVideo] = useState(false)

  const finish = useCallback(() => {
    if (doneRef.current) return
    doneRef.current = true
    markSplashDone()

    const early = document.getElementById(EARLY_ID)
    if (early) {
      fadeOutEarlySplash(early, onDone)
      return
    }

    setFading(true)
    window.setTimeout(() => onDone(), 320)
  }, [onDone])

  // 接管 early splash 或回退到 React 自管视频
  useEffect(() => {
    const early = document.getElementById(EARLY_ID)
    const earlyFg = document.getElementById(FG_ID) as HTMLVideoElement | null

    if (early && earlyFg) {
      const onEnded = () => finish()
      const onError = () => finish()
      earlyFg.addEventListener('ended', onEnded)
      earlyFg.addEventListener('error', onError)

      // 若 early 已播完（React 挂载偏晚），直接结束
      if (earlyFg.ended || earlyFg.error) {
        finish()
      }

      const fallback = window.setTimeout(() => finish(), FALLBACK_MS)
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

    const onEnded = () => finish()
    const onError = () => finish()
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
          finish()
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

    const fallback = window.setTimeout(() => finish(), FALLBACK_MS)
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
