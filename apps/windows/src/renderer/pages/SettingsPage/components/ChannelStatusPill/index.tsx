/**
 * 渠道连接状态徽章。
 *
 * 三个渠道（微信 / 企微 / 飞书）各自的 status 枚举先归一到四个语义态，
 * 再由本组件统一渲染，避免每张卡片各写一套 Tag 配色。
 */
import React from 'react'
import styles from './ChannelStatusPill.module.css'

/** 渠道连接的语义状态（各渠道私有 status 归一后的结果） */
export type ChannelConnectionState = 'connected' | 'pending' | 'idle' | 'error'

export interface ChannelStatusPillProps {
  state: ChannelConnectionState
  /** 展示文案，如「已连接」「等待扫码」 */
  label: string
}

/**
 * 渲染状态徽章：圆点颜色与背景底色由语义状态决定。
 */
export const ChannelStatusPill: React.FC<ChannelStatusPillProps> = ({ state, label }) => (
  <span className={`${styles.pill} ${styles[state]}`}>
    <span className={styles.dot} />
    {label}
  </span>
)

export default ChannelStatusPill
