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
            background: 'var(--mt-grad-brand)',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            // 必须用 -webkit-text-fill-color 而不是 color: transparent：
            // 后者在 background-clip: text 未生效时会让文字不可见、同时渐变
            // 铺成一块实心色（曾实测到"蓝色方块 + 看不见字"）。
            // -webkit-text-fill-color 与之配套，是 Chromium 下的正确写法。
            WebkitTextFillColor: 'transparent',
          }}
        >
          Lumii
        </span>
      )}
    </span>
  )
}
