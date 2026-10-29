import React, { useCallback, useEffect, useState } from 'react'
import { TimerReset, X } from 'lucide-react'
import styles from './CronWakeBanner.module.css'

interface CronWakeBannerProps {
  jobName: string
  /** 唤醒时刻（epoch ms） */
  at: number
  onDismiss: () => void
}

/** 提示自己消失的时间：只是「刚刚发生过」的交代，不是待办 */
const AUTO_HIDE_MS = 10 * 60 * 1000

function formatAgo(at: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} 小时前` : `${Math.floor(hours / 24)} 天前`
}

/**
 * 「这条会话刚被定时任务唤醒」的提示条。
 *
 * 为什么不往消息列表插一条：注入走的是 internal 来源、**不写 user 消息**，插一条
 * 用户没说过的话会让历史失真；刷新后消失也无所谓——它不是消息，是提示。
 */
export const CronWakeBanner: React.FC<CronWakeBannerProps> = ({ jobName, at, onDismiss }) => {
  const [now, setNow] = useState(() => Date.now())

  // 到点自动收起；用户切回这条会话时若已过期，下一次 tick 就会把它拿掉
  useEffect(() => {
    const remaining = at + AUTO_HIDE_MS - Date.now()
    if (remaining <= 0) {
      onDismiss()
      return
    }
    const timer = setTimeout(() => setNow(Date.now()), remaining)
    return () => clearTimeout(timer)
  }, [at, onDismiss])

  const handleDismiss = useCallback(() => onDismiss(), [onDismiss])

  if (now - at >= AUTO_HIDE_MS) return null

  return (
    <div className={styles.banner} role="status">
      <span className={styles.icon}>
        <TimerReset size={15} strokeWidth={2} />
      </span>
      <span className={styles.text}>
        定时任务「{jobName}」唤醒了本会话
        <span className={styles.time}>· {formatAgo(at, now)}</span>
      </span>
      <button className={styles.close} onClick={handleDismiss} aria-label="关闭提示">
        <X size={14} />
      </button>
    </div>
  )
}
