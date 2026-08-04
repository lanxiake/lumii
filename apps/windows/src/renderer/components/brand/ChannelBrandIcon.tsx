/**
 * 渠道品牌字标（官方色 + 单字，避免假冒复杂 logo）
 */

import React from 'react'

export type ChannelBrandKind = 'weixin' | 'wecom' | 'feishu'

const BRAND: Record<
  ChannelBrandKind,
  { bg: string; fg: string; label: string; title: string }
> = {
  weixin: { bg: '#07C160', fg: '#fff', label: '微', title: '微信' },
  wecom: { bg: '#2B7BD6', fg: '#fff', label: '企', title: '企业微信' },
  feishu: { bg: '#3370FF', fg: '#fff', label: '飞', title: '飞书' },
}

export interface ChannelBrandIconProps {
  kind: ChannelBrandKind
  size?: number
}

/**
 * 渲染渠道官方色块字标
 */
export const ChannelBrandIcon: React.FC<ChannelBrandIconProps> = ({
  kind,
  size = 28,
}) => {
  const b = BRAND[kind]
  return (
    <span
      title={b.title}
      aria-label={b.title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.28),
        background: b.bg,
        color: b.fg,
        fontSize: Math.round(size * 0.48),
        fontWeight: 700,
        lineHeight: 1,
        flexShrink: 0,
        letterSpacing: 0,
        userSelect: 'none',
      }}
    >
      {b.label}
    </span>
  )
}

export default ChannelBrandIcon
