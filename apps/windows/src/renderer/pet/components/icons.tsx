/**
 * 虚拟人控制坞图标 - 内联 SVG 组件
 *
 * 替代原 emoji（🎤🔊🔇⏹➤🔔），统一线性图标风格（currentColor + 1.6 stroke）。
 * 全部 16x16 viewBox，继承父级 color，无外部依赖。
 */

import React from 'react'

interface IconProps {
  size?: number
  className?: string
}

const base = (size: number): React.SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
})

/** 麦克风：开始语音对话 */
export const MicIcon: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className} aria-hidden>
    <rect x="6" y="1.5" width="4" height="8" rx="2" />
    <path d="M3.5 7a4.5 4.5 0 0 0 9 0" />
    <path d="M8 11.5V14" />
    <path d="M5.5 14h5" />
  </svg>
)

/** 扬声器（有声）：声音开 / 取消静音 */
export const VolumeOnIcon: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className} aria-hidden>
    <path d="M2.5 6v4h2.5L8.5 13V3L5 6H2.5Z" />
    <path d="M11 5.5a3.5 3.5 0 0 1 0 5" />
    <path d="M12.8 3.5a6 6 0 0 1 0 9" />
  </svg>
)

/** 扬声器（静音）：声音关 / 静音 */
export const VolumeOffIcon: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className} aria-hidden>
    <path d="M2.5 6v4h2.5L8.5 13V3L5 6H2.5Z" />
    <path d="M11 6l3 4" />
    <path d="M14 6l-3 4" />
  </svg>
)

/** 停止（方块）：挂断通话 */
export const StopIcon: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className} aria-hidden>
    <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />
  </svg>
)

/** 发送（纸飞机箭头） */
export const SendIcon: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className} aria-hidden>
    <path d="M2 8h10" />
    <path d="M8 4l4 4-4 4" />
  </svg>
)

/** 状态指示（铃铛） */
export const BellIcon: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className} aria-hidden>
    <path d="M4 6.5a4 4 0 0 1 8 0c0 3 1 4 1 4H3s1-1 1-4Z" />
    <path d="M6.5 13a1.5 1.5 0 0 0 3 0" />
  </svg>
)

/** 设置（齿轮）：展开语音参数面板 */
export const GearIcon: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className} aria-hidden>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4" />
  </svg>
)

/** 随机待机动作开启（小人 + 运动弧线） */
export const MotionOnIcon: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className} aria-hidden>
    <circle cx="8" cy="3.5" r="1.5" fill="currentColor" stroke="none" />
    <path d="M8 5v3.5M6 7.5h4M7 11l-2 3M9 11l2 3" />
    <path d="M2 5.5c1.5-1 3-1 4.5 0M9.5 5.5c1.5-1 3-1 4.5 0" />
  </svg>
)

/** 随机待机动作关闭（小人静止） */
export const MotionOffIcon: React.FC<IconProps> = ({ size = 16, className }) => (
  <svg {...base(size)} className={className} aria-hidden>
    <circle cx="8" cy="3.5" r="1.5" fill="currentColor" stroke="none" />
    <path d="M8 5v3.5M6 7.5h4M7.5 11v3M8.5 11v3" />
    <path d="M3 13.5h10" />
  </svg>
)
