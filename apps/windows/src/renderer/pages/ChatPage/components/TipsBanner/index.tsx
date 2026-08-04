import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Lightbulb, ChevronLeft, ChevronRight } from 'lucide-react'
import styles from './TipsBanner.module.css'
import { INPUT_TIPS } from './useRotatingTip'

interface TipsBannerProps {
  interval?: number
}

/** 底部 Tips 轮播条（独立展示，非输入框 placeholder） */
const TipsBanner: React.FC<TipsBannerProps> = ({ interval = 8000 }) => {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * INPUT_TIPS.length))
  const [visible, setVisible] = useState(true)
  const [hovered, setHovered] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const advance = useCallback((dir: 1 | -1 = 1) => {
    setVisible(false)
    setTimeout(() => {
      setIndex((i) => (i + dir + INPUT_TIPS.length) % INPUT_TIPS.length)
      setVisible(true)
    }, 180)
  }, [])

  useEffect(() => {
    if (hovered) {
      if (timerRef.current) clearInterval(timerRef.current)
      return
    }
    timerRef.current = setInterval(() => advance(1), interval)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [hovered, interval, advance])

  const tip = INPUT_TIPS[index]

  return (
    <div
      className={`${styles.banner} ${hovered ? styles.visible : styles.faded}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className={styles.icon}>
        <Lightbulb size={12} strokeWidth={2} />
      </span>
      <span className={styles.text}>
        {tip.text}
        {tip.command && (
          <kbd className={styles.cmd}>{tip.command}</kbd>
        )}
      </span>
      <div className={styles.controls}>
        <button className={styles.nav} onClick={() => advance(-1)} title="上一条">
          <ChevronLeft size={11} />
        </button>
        <span className={styles.counter}>{index + 1}/{INPUT_TIPS.length}</span>
        <button className={styles.nav} onClick={() => advance(1)} title="下一条">
          <ChevronRight size={11} />
        </button>
      </div>
    </div>
  )
}

export { TipsBanner }
export { useRotatingTip, INPUT_TIPS } from './useRotatingTip'
export default TipsBanner
