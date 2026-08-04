/**
 * 滑动验证码组件 (Windows 客户端)
 *
 * 显示背景图（含缺口）+ 可拖拽滑块
 * 拖动完成后回调 onVerify(sliderX)
 */

import React, { useState, useRef, useCallback, useEffect } from 'react'
import styles from './SlidingCaptcha.module.css'

interface SlidingCaptchaProps {
  /** 背景图 base64 (含缺口) */
  backgroundImage: string | null
  /** 滑块图 base64 */
  sliderImage: string | null
  /** 滑块 Y 坐标 */
  sliderY: number
  /** 是否已验证 */
  isVerified: boolean
  /** 是否加载中 */
  isLoading: boolean
  /** 错误信息 */
  error: string | null
  /** 拖动完成回调 */
  onVerify: (sliderX: number) => void
  /** 刷新回调 */
  onRefresh: () => void
}

const BG_WIDTH = 280
const BG_HEIGHT = 100
const SLIDER_SIZE = 40
const TRACK_HEIGHT = 32

export const SlidingCaptcha: React.FC<SlidingCaptchaProps> = ({
  backgroundImage,
  sliderImage,
  sliderY,
  isVerified,
  isLoading,
  error,
  onVerify,
  onRefresh,
}) => {
  const [dragX, setDragX] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const trackRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isDragging && !isVerified) {
      setDragX(0)
    }
  }, [backgroundImage, isDragging, isVerified])

  const getSliderXFromEvent = useCallback(
    (clientX: number): number => {
      if (!trackRef.current) return 0
      const rect = trackRef.current.getBoundingClientRect()
      const x = clientX - rect.left - SLIDER_SIZE / 2
      return Math.max(0, Math.min(x, BG_WIDTH - SLIDER_SIZE))
    },
    []
  )

  const handleDragStart = useCallback(
    (clientX: number) => {
      if (isVerified || isLoading) return
      setIsDragging(true)
      setDragX(getSliderXFromEvent(clientX))
    },
    [isVerified, isLoading, getSliderXFromEvent]
  )

  const handleDragMove = useCallback(
    (clientX: number) => {
      if (!isDragging) return
      setDragX(getSliderXFromEvent(clientX))
    },
    [isDragging, getSliderXFromEvent]
  )

  const handleDragEnd = useCallback(() => {
    if (!isDragging) return
    setIsDragging(false)
    if (dragX > 10) {
      onVerify(dragX)
    }
  }, [isDragging, dragX, onVerify])

  useEffect(() => {
    if (!isDragging) return

    const onMouseMove = (e: MouseEvent) => handleDragMove(e.clientX)
    const onMouseUp = () => handleDragEnd()
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches[0]) handleDragMove(e.touches[0].clientX)
    }
    const onTouchEnd = () => handleDragEnd()

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('touchmove', onTouchMove)
    document.addEventListener('touchend', onTouchEnd)

    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('touchmove', onTouchMove)
      document.removeEventListener('touchend', onTouchEnd)
    }
  }, [isDragging, handleDragMove, handleDragEnd])

  if (!backgroundImage || !sliderImage) {
    return (
      <div className={styles['captcha-placeholder']} style={{ width: BG_WIDTH, height: BG_HEIGHT + TRACK_HEIGHT + 8 }}>
        {isLoading ? (
          <span className={styles['captcha-loading-text']}>加载中...</span>
        ) : (
          <span className={styles['captcha-loading-text']}>加载验证码...</span>
        )}
      </div>
    )
  }

  return (
    <div className={styles['captcha-container']} style={{ width: BG_WIDTH }}>
      {/* 背景图 + 滑块 */}
      <div className={styles['captcha-image-area']} style={{ width: BG_WIDTH, height: BG_HEIGHT }}>
        <img
          src={backgroundImage}
          alt="captcha"
          draggable={false}
          style={{ width: BG_WIDTH, height: BG_HEIGHT }}
          className={styles['captcha-bg-image']}
        />
        {!isVerified && (
          <img
            src={sliderImage}
            alt="slider"
            draggable={false}
            className={styles['captcha-slider-piece']}
            style={{
              width: SLIDER_SIZE,
              height: SLIDER_SIZE,
              left: dragX,
              top: sliderY,
            }}
          />
        )}
        <button
          type="button"
          onClick={onRefresh}
          disabled={isLoading}
          className={styles['captcha-refresh-btn']}
          title="刷新验证码"
        >
          ↻
        </button>
      </div>

      {/* 滑动轨道 */}
      <div
        ref={trackRef}
        className={`${styles['captcha-track']} ${isVerified ? styles['verified'] : ''}`}
        style={{ width: BG_WIDTH, height: TRACK_HEIGHT }}
        onMouseDown={(e) => {
          e.preventDefault()
          handleDragStart(e.clientX)
        }}
        onTouchStart={(e) => {
          if (e.touches[0]) handleDragStart(e.touches[0].clientX)
        }}
      >
        {isVerified ? (
          <div className={styles['captcha-verified-text']}>✓ 验证成功</div>
        ) : (
          <>
            <div
              className={styles['captcha-track-fill']}
              style={{ width: dragX + SLIDER_SIZE / 2 }}
            />
            <div className={styles['captcha-track-hint']}>
              {isDragging ? '' : '向右拖动滑块完成验证'}
            </div>
            <div
              className={`${styles['captcha-slider-handle']} ${isDragging ? styles['dragging'] : ''}`}
              style={{ left: dragX, width: SLIDER_SIZE }}
            >
              <span className={styles['captcha-slider-grip']}>|||</span>
            </div>
          </>
        )}
      </div>

      {error && <p className={styles['captcha-error']}>{error}</p>}
    </div>
  )
}
