/**
 * LumiiLogo — 灵栖品牌标识（使用产品 logo 图片）
 */

import React from 'react'
import logoSrc from '@app-assets/logo.png'

export interface LumiiLogoProps {
  /** 图标边长（px） */
  size?: number
  /** 是否显示文字「Lumii」 */
  showWordmark?: boolean
  /** 额外 className */
  className?: string
}

/**
 * 渲染 Lumii 品牌 Logo（图片 + 可选文字）
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
      <img
        src={logoSrc}
        alt="灵栖 Lumii"
        width={size}
        height={size}
        draggable={false}
        style={{
          width: size,
          height: size,
          objectFit: 'contain',
          borderRadius: Math.max(4, Math.round(size * 0.18)),
          flexShrink: 0,
          display: 'block',
        }}
      />
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
