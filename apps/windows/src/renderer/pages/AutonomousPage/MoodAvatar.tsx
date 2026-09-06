/**
 * MoodAvatar — 「灵栖小龙」卡通中国龙，用 SVG 手绘 + 动画动态表达情绪
 *
 * 参考品牌 logo 的青碧配色（青龙/灵栖意象）绘制一只圆滚滚的小龙：
 * - 鹿角状龙角 + 龙须 + 小鼻子，是「中国龙」的识别点，用金色/浅青固定不随情绪变
 * - 身体始终在青蓝/碧色系（青龙），情绪主要靠五官 + 光晕 + 动作透出
 * - energy → 漂浮速度与幅度；valence → 表情（开心/低落）；arousal → 光晕强度与灵光粒子
 */

import React, { useId, useMemo } from 'react'
import styles from './MoodAvatar.module.css'

export interface MoodAvatarMood {
  energy: number // 0..1
  valence: number // -1..1
  arousal: number // 0..1
}

export type MoodEmotion = 'joy' | 'sadness' | 'sleepy' | 'surprise' | 'neutral'

interface EmotionStyle {
  glow: string // 光晕 RGB 分量
  accent: string // 情绪点缀色（徽标/粒子）
  bodyTop: string // 龙身渐变上
  bodyBottom: string // 龙身渐变下
  blush: number // 腮红透明度
  label: string
}

const EMOTION_STYLES: Record<MoodEmotion, EmotionStyle> = {
  joy: { glow: '251, 191, 36', accent: '#f59e0b', bodyTop: '#9be4fb', bodyBottom: '#38bdf8', blush: 0.6, label: '开心' },
  sadness: { glow: '96, 165, 250', accent: '#60a5fa', bodyTop: '#a8c6f5', bodyBottom: '#6a93e8', blush: 0.25, label: '低落' },
  sleepy: { glow: '129, 140, 248', accent: '#818cf8', bodyTop: '#b3bceb', bodyBottom: '#8b92d6', blush: 0.3, label: '困倦' },
  surprise: { glow: '167, 139, 250', accent: '#a78bfa', bodyTop: '#99e6d8', bodyBottom: '#2dd4bf', blush: 0.5, label: '好奇' },
  neutral: { glow: '56, 189, 248', accent: '#38bdf8', bodyTop: '#7dd3fc', bodyBottom: '#2f9ef0', blush: 0.42, label: '平静' },
}

/** 圆滚滚的龙脑袋（宽下巴、微鼓腮帮） */
const HEAD_PATH =
  'M60 33 C81 33 96 49 96 69 C96 91 80 102 60 102 C40 102 24 91 24 69 C24 49 39 33 60 33 Z'

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
 * 情绪头像：光晕 + 漂浮的小龙 + 高兴致时的灵光粒子。
 */
export function MoodAvatar({ mood, size = 96 }: MoodAvatarProps) {
  const emotion = useMemo(() => moodToEmotion(mood), [mood])
  const e = EMOTION_STYLES[emotion]
  const gradId = useId()

  const floatDuration = Math.max(1.2, 3.4 - mood.energy * 2.0)
  const floatAmp = 5 + mood.energy * 14
  const glowOpacity = 0.3 + mood.arousal * 0.45
  const showSparkles = mood.arousal > 0.5

  const cssVars = {
    '--mood-float-duration': `${floatDuration}s`,
    '--mood-float-amp': `${floatAmp}px`,
    '--mood-glow': e.glow,
    '--mood-glow-opacity': glowOpacity.toFixed(2),
    '--mood-accent': e.accent,
  } as React.CSSProperties

  return (
    <div className={styles.moodAvatar} style={{ ...cssVars, width: size, height: size }}>
      <div className={styles.halo} />
      <svg
        viewBox="0 0 120 120"
        className={styles.mascot}
        role="img"
        aria-label={`灵栖小龙 · ${e.label}`}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={e.bodyTop} />
            <stop offset="100%" stopColor={e.bodyBottom} />
          </linearGradient>
        </defs>

        {/* 尾巴（从脑袋右下方探出） */}
        <path
          d="M82 96 Q98 98 95 85 Q93 77 99 72"
          stroke={e.bodyBottom}
          strokeWidth="6"
          fill="none"
          strokeLinecap="round"
          opacity="0.9"
        />

        {/* 脑袋 */}
        <path d={HEAD_PATH} fill={`url(#${gradId})`} />
        {/* 高光 */}
        <ellipse className={styles.shine} cx="46" cy="52" rx="14" ry="9" transform="rotate(-20 46 52)" />

        {/* 鹿角状龙角（金色，小龙的识别点） */}
        <g className={styles.horns} stroke="#fbbf24" strokeWidth="3.2" fill="none" strokeLinecap="round" strokeLinejoin="round">
          <path d="M46 38 Q42 28 35 18" />
          <path d="M42 28 Q47 23 53 20" />
          <path d="M74 38 Q78 28 85 18" />
          <path d="M78 28 Q73 23 67 20" />
        </g>

        {/* 龙须（浅青，轻柔摆动） */}
        <g className={styles.whiskers} stroke="#e0f2fe" strokeWidth="1.8" fill="none" strokeLinecap="round">
          <path d="M47 85 Q36 94 29 88" />
          <path d="M73 85 Q84 94 91 88" />
        </g>

        {/* 小鼻子 */}
        <ellipse cx="60" cy="81" rx="16" ry="9" fill="#fff" opacity="0.38" />
        <circle cx="55" cy="80" r="1.4" fill="#1e293b" />
        <circle cx="65" cy="80" r="1.4" fill="#1e293b" />

        <DragonFace emotion={emotion} blush={e.blush} />

        {/* 好奇时的灵光粒子 */}
        {showSparkles && (
          <g className={styles.sparklesSvg} fill={e.accent}>
            <circle cx="34" cy="56" r="1.6" className={styles.sparkle} />
            <circle cx="89" cy="48" r="1.4" className={styles.sparkle} style={{ animationDelay: '0.5s' }} />
            <circle cx="78" cy="92" r="1.6" className={styles.sparkle} style={{ animationDelay: '1s' }} />
          </g>
        )}
      </svg>

      {showSparkles && (
        <div className={styles.sparkles} aria-hidden>
          <span className={`${styles.sparkle} ${styles.sparkleA}`} />
          <span className={`${styles.sparkle} ${styles.sparkleB}`} />
          <span className={`${styles.sparkle} ${styles.sparkleC}`} />
        </div>
      )}

      <span className={styles.emotionBadge} title={e.label}>
        {e.label}
      </span>
    </div>
  )
}

/** 单只眼睛 */
function Eye({ cx, cy, variant }: { cx: number; cy: number; variant: 'round' | 'wide' | 'closed' }) {
  if (variant === 'closed') {
    return (
      <path
        d={`M${cx - 8} ${cy} Q${cx} ${cy + 6} ${cx + 8} ${cy}`}
        stroke="#1e293b"
        strokeWidth="2.6"
        fill="none"
        strokeLinecap="round"
      />
    )
  }
  const rx = variant === 'wide' ? 9 : 8
  const ry = variant === 'wide' ? 10 : 9
  const pupilR = variant === 'wide' ? 3.2 : 4.2
  return (
    <g className={styles.eye}>
      <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="#fff" />
      <circle cx={cx} cy={cy + 1} r={pupilR} fill="#1e293b" />
      <circle cx={cx + 1.6} cy={cy - 1.6} r={1.6} fill="#fff" />
    </g>
  )
}

/** 小龙表情：腮红 + 眉 + 眼 + 嘴 + 眼泪/瞌睡气泡 */
function DragonFace({ emotion, blush }: { emotion: MoodEmotion; blush: number }) {
  const eyeVariant: 'round' | 'wide' | 'closed' =
    emotion === 'surprise' ? 'wide' : emotion === 'sleepy' ? 'closed' : 'round'

  return (
    <g>
      {/* 腮红 */}
      <ellipse cx="37" cy="74" rx="6.5" ry="3.6" fill="#fb7185" opacity={blush} />
      <ellipse cx="83" cy="74" rx="6.5" ry="3.6" fill="#fb7185" opacity={blush} />

      {/* 眉毛（惊讶高挑 / 低落微蹙） */}
      {emotion === 'surprise' && (
        <g stroke="#1e293b" strokeWidth="2.2" fill="none" strokeLinecap="round">
          <path d="M39 46 Q46 42 53 46" />
          <path d="M67 46 Q74 42 81 46" />
        </g>
      )}
      {emotion === 'sadness' && (
        <g stroke="#1e293b" strokeWidth="2.2" fill="none" strokeLinecap="round">
          <path d="M39 48 Q46 44 53 46" />
          <path d="M67 46 Q74 44 81 48" />
        </g>
      )}

      {/* 眼睛 */}
      <Eye cx={46} cy={58} variant={eyeVariant} />
      <Eye cx={74} cy={58} variant={eyeVariant} />

      {/* 嘴 */}
      {emotion === 'joy' && <path d="M50 89 Q60 99 70 89 Z" fill="#1e293b" />}
      {emotion === 'neutral' && (
        <path d="M54 90 Q60 94 66 90" stroke="#1e293b" strokeWidth="2.4" fill="none" strokeLinecap="round" />
      )}
      {emotion === 'sadness' && (
        <path d="M54 92 Q60 87 66 92" stroke="#1e293b" strokeWidth="2.4" fill="none" strokeLinecap="round" />
      )}
      {emotion === 'surprise' && <circle cx="60" cy="90" r="4.2" fill="#1e293b" />}
      {emotion === 'sleepy' && <circle cx="60" cy="91" r="2.4" fill="#1e293b" />}

      {/* 低落：眼泪 */}
      {emotion === 'sadness' && (
        <path className={styles.tear} d="M43 68 Q41 72 43 74 Q45 72 43 68 Z" fill="#7dd3fc" />
      )}

      {/* 困倦：zzz */}
      {emotion === 'sleepy' && (
        <g>
          <text
            className={styles.zzz}
            x="84"
            y="46"
            fontSize="11"
            fontWeight="700"
            fill="#818cf8"
            fontFamily="system-ui, sans-serif"
          >
            z
          </text>
          <text
            className={styles.zzz2}
            x="93"
            y="36"
            fontSize="9"
            fontWeight="700"
            fill="#a5b4fc"
            fontFamily="system-ui, sans-serif"
          >
            z
          </text>
        </g>
      )}
    </g>
  )
}

export default MoodAvatar
