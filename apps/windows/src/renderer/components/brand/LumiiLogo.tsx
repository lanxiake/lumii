/**
 * LumiiLogo — 灵栖品牌标识（光栖：柔和光晕 + 抽象 L）
 */

import React from 'react'

export interface LumiiLogoProps {
  /** 图标边长（px） */
  size?: number
  /** 是否显示文字「Lumii」 */
  showWordmark?: boolean
  /** 额外 className */
  className?: string
}

/**
 * 渲染 Lumii 品牌 Logo（SVG）
 */
export const LumiiLogo: React.FC<LumiiLogoProps> = ({
  size = 28,
  showWordmark = false,
  className,
}) => {
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        lineHeight: 1,
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-label="Lumii"
        role="img"
      >
        <defs>
          <linearGradient id="lumiiGrad" x1="12" y1="8" x2="52" y2="56" gradientUnits="userSpaceOnUse">
            <stop stopColor="#7DD3FC" />
            <stop offset="0.45" stopColor="#38BDF8" />
            <stop offset="1" stopColor="#2563EB" />
          </linearGradient>
          <radialGradient id="lumiiGlow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(32 28) rotate(90) scale(28 28)">
            <stop stopColor="#7DD3FC" stopOpacity="0.55" />
            <stop offset="1" stopColor="#2563EB" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="32" cy="32" r="30" fill="url(#lumiiGlow)" />
        <circle cx="32" cy="32" r="22" fill="url(#lumiiGrad)" />
        {/* 抽象栖息光弧 */}
        <path
          d="M22 38.5C22 30.5 27.2 24 34.5 24C40.2 24 44.5 27.8 45.5 33"
          stroke="white"
          strokeWidth="3.2"
          strokeLinecap="round"
          fill="none"
          opacity="0.92"
        />
        {/* L 形光柱 */}
        <path
          d="M26 20.5V43.5H40"
          stroke="white"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity="0.95"
        />
      </svg>
      {showWordmark && (
        <span
          style={{
            fontWeight: 700,
            fontSize: Math.max(14, size * 0.55),
            letterSpacing: '0.02em',
            background: 'linear-gradient(180deg, #7dd3fc 0%, #38bdf8 35%, #2563eb 100%)',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            color: 'transparent',
          }}
        >
          Lumii
        </span>
      )}
    </span>
  )
}

export default LumiiLogo
