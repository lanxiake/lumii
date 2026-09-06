/**
 * MoodAvatar — 用 Lumii logo 形象动态表达情绪状态
 *
 * 将三维情绪（energy 精力 / valence 心情 / arousal 兴致）映射为动画参数：
 * - energy → 浮动速度与幅度（精力越足跳得越快越高，越累越沉）
 * - valence → 光晕冷暖（正向偏暖、负向偏冷）
 * - arousal → 光晕强度与「灵光」粒子（兴致越高越闪烁）
 *
 * 情绪只通过动作与光晕透出，不直接展示数值，避免表演情绪。
 */

import React, { useMemo } from 'react'
import logoSrc from '@app-assets/logo.png'
import styles from './MoodAvatar.module.css'

export interface MoodAvatarMood {
  energy: number // 0..1
  valence: number // -1..1
  arousal: number // 0..1
}

export type MoodEmotion = 'joy' | 'sadness' | 'sleepy' | 'surprise' | 'neutral'

/** 情绪 → 光晕/点缀色（对齐品牌蓝，正向暖、负向冷、好奇偏紫） */
const EMOTION_COLORS: Record<MoodEmotion, { glow: string; accent: string }> = {
  joy: { glow: '251, 191, 36', accent: '#f59e0b' },
  sadness: { glow: '96, 165, 250', accent: '#60a5fa' },
  sleepy: { glow: '129, 140, 248', accent: '#818cf8' },
  surprise: { glow: '167, 139, 250', accent: '#a78bfa' },
  neutral: { glow: '56, 189, 248', accent: '#38bdf8' },
}

/** 情绪 → 简短标签（无障碍 + 悬停可读） */
const EMOTION_LABELS: Record<MoodEmotion, string> = {
  joy: '开心',
  sadness: '低落',
  sleepy: '困倦',
  surprise: '好奇',
  neutral: '平静',
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
 * 情绪头像：光晕 + 浮动的 logo + 高兴致时闪烁的灵光粒子。
 */
export function MoodAvatar({ mood, size = 96 }: MoodAvatarProps) {
  const emotion = useMemo(() => moodToEmotion(mood), [mood])
  const colors = EMOTION_COLORS[emotion]

  // energy → 浮动速度/幅度；arousal → 光晕强度；valence → 冷暖（已并入颜色表）
  const floatDuration = Math.max(1.2, 3.4 - mood.energy * 2.0) // 秒，精力越足越快
  const floatAmp = 5 + mood.energy * 14 // px
  const glowOpacity = 0.3 + mood.arousal * 0.45
  const showSparkles = mood.arousal > 0.5

  const cssVars = {
    '--mood-float-duration': `${floatDuration}s`,
    '--mood-float-amp': `${floatAmp}px`,
    '--mood-glow': colors.glow,
    '--mood-glow-opacity': glowOpacity.toFixed(2),
    '--mood-accent': colors.accent,
  } as React.CSSProperties

  return (
    <div className={styles.moodAvatar} style={{ ...cssVars, width: size, height: size }}>
      <div className={styles.halo} />
      <img
        src={logoSrc}
        alt={`灵栖 Lumii · ${EMOTION_LABELS[emotion]}`}
        className={styles.logo}
        draggable={false}
      />
      {showSparkles && (
        <div className={styles.sparkles} aria-hidden>
          <span className={`${styles.sparkle} ${styles.sparkleA}`} />
          <span className={`${styles.sparkle} ${styles.sparkleB}`} />
          <span className={`${styles.sparkle} ${styles.sparkleC}`} />
        </div>
      )}
      <span className={styles.emotionBadge} title={EMOTION_LABELS[emotion]}>
        {EMOTION_LABELS[emotion]}
      </span>
    </div>
  )
}

export default MoodAvatar
