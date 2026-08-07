/**
 * SplashOverlay — 主窗口内全屏开机画面
 *
 * 底层用同一视频模糊铺满左右（相似画面补边），上层清晰主画面居中 contain，
 * 避免宽屏两侧留大块空黑。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import splashUrl from '@app-assets/splash.mp4'
import styles from './SplashOverlay.module.css'

export interface SplashOverlayProps {
  /** 播放结束（或跳过/出错）后回调 */
  onDone: () => void
}

const FALLBACK_MS = 12_000

/**
 * 主窗口内全屏播放开机动画
 */
export const SplashOverlay: React.FC<SplashOverlayProps> = ({ onDone }) => {
  const fgRef = useRef<HTMLVideoElement>(null)
  const bgRef = useRef<HTMLVideoElement>(null)
  const doneRef = useRef(false)
  const [fading, setFading] = useState(false)

  const finish = useCallback(() => {
    if (doneRef.current) return
    doneRef.current = true
    setFading(true)
    window.setTimeout(() => {
      try {
        sessionStorage.setItem('lumii.splash.done', '1')
      } catch {
        // ignore
      }
      onDone()
    }, 320)
  }, [onDone])

  useEffect(() => {
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
  }, [finish])

  return (
    <div
      className={`${styles.overlay} ${fading ? styles.fading : ''}`}
      role="presentation"
      aria-label="灵栖启动动画"
    >
      {/* 模糊铺底：左右铺满，与主画面同源 */}
      <video
        ref={bgRef}
        className={styles.bgVideo}
        src={splashUrl}
        muted
        playsInline
        preload="auto"
        aria-hidden="true"
      />
      <div className={styles.vignette} aria-hidden="true" />
      <div className={styles.sideGlow} aria-hidden="true" />

      {/* 清晰主画面 */}
      <video
        ref={fgRef}
        className={styles.fgVideo}
        src={splashUrl}
        autoPlay
        playsInline
        preload="auto"
      />
    </div>
  )
}

export default SplashOverlay
