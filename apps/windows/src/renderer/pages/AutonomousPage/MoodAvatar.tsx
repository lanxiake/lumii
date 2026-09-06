/**
 * MoodAvatar — 「灵栖团子」软萌卡通角色，用 lottie-web 播放原创 Lottie 动画表达情绪
 *
 * 团子本体固定青碧色系（品牌识别点），情绪主要靠三处透出：
 * - halo 光晕颜色（EMOTION_STYLES.glow）随情绪呼吸
 * - 播放速度随 energy（精力越足越快，困倦放慢）
 * - 右下角情绪徽标文字
 * 团子的眨眼/腮红/微笑由原创 Lottie 数据（MoodAvatar.lottie.ts）绘制。
 */

import React, { useEffect, useMemo, useRef } from 'react'
import lottie from 'lottie-web'
import { moodLottieData } from './MoodAvatar.lottie'
import styles from './MoodAvatar.module.css'

export interface MoodAvatarMood {
  energy: number // 0..1
  valence: number // -1..1
  arousal: number // 0..1
}

export type MoodEmotion = 'joy' | 'sadness' | 'sleepy' | 'surprise' | 'neutral'

interface EmotionStyle {
  glow: string // 光晕 RGB 分量
  accent: string // 情绪徽标颜色
  label: string
}

const EMOTION_STYLES: Record<MoodEmotion, EmotionStyle> = {
  joy: { glow: '251, 191, 36', accent: '#f59e0b', label: '开心' },
  sadness: { glow: '96, 165, 250', accent: '#60a5fa', label: '低落' },
  sleepy: { glow: '129, 140, 248', accent: '#818cf8', label: '困倦' },
  surprise: { glow: '167, 139, 250', accent: '#a78bfa', label: '好奇' },
  neutral: { glow: '56, 189, 248', accent: '#38bdf8', label: '平静' },
}

/** 三维情绪 → 表情（对齐 moodToPetEmotion，扩展困倦） */
export function moodToEmotion(mood: MoodAvatarMood): MoodEmotion {
  if (mood.valence > 0.3 && mood.energy > 0.6) return 'joy'
  if (mood.arousal > 0.6) return 'surprise'
  if (mood.energy < 0.3) return 'sleepy'
  if (mood.valence < -0.3) return 'sadness'
  return 'neutral'
}

export interface MoodAvatarProps {
  mood: MoodAvatarMood
  /** 头像边长（px），默认 96 */
  size?: number
}

/**
 * 情绪头像：光晕 + 软团子 Lottie + 情绪徽标。
 */
export function MoodAvatar({ mood, size = 96 }: MoodAvatarProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const animRef = useRef<ReturnType<typeof lottie.loadAnimation> | null>(null)

  const emotion = useMemo(() => moodToEmotion(mood), [mood])
  const e = EMOTION_STYLES[emotion]

  // 播放速度：精力越足越快（困倦 ~0.5，高精力 ~1.5）
  const speed = Math.max(0.5, 0.55 + mood.energy * 0.95)
  const glowOpacity = 0.3 + mood.arousal * 0.45
  const floatDuration = Math.max(1.2, 3.4 - mood.energy * 2.0)
  const floatAmp = 5 + mood.energy * 14

  // 装载 Lottie（仅一次），卸载时销毁避免内存泄漏
  useEffect(() => {
    if (!containerRef.current) return
    const anim = lottie.loadAnimation({
      container: containerRef.current,
      renderer: 'svg',
      loop: true,
      autoplay: true,
      animationData: moodLottieData,
    })
    animRef.current = anim
    return () => {
      anim.destroy()
      animRef.current = null
    }
  }, [])

  // 情绪变化时调整播放速度
  useEffect(() => {
    animRef.current?.setSpeed(speed)
  }, [speed])

  const cssVars = {
    '--mood-glow': e.glow,
    '--mood-glow-opacity': glowOpacity.toFixed(2),
    '--mood-accent': e.accent,
    '--mood-float-duration': `${floatDuration}s`,
    '--mood-float-amp': `${floatAmp}px`,
  } as React.CSSProperties

  return (
    <div className={styles.moodAvatar} style={{ ...cssVars, width: size, height: size }}>
      <div className={styles.halo} />
      <div className={styles.lottie} ref={containerRef} aria-hidden />
      <span className={styles.emotionBadge} title={e.label}>
        {e.label}
      </span>
    </div>
  )
}

export default MoodAvatar
