/**
 * 对话右侧的「我说的每一句」条纹导轨。
 *
 * 一条 = 一条用户输入；点一条就跳到那条消息（复用 ChatContainer 的 focusMessageId）。
 * 只有超过一条时才显示 —— 一条时这个导轨没有任何导航价值，只是噪音。
 *
 * 三条交互取舍：
 * - **命中区比视觉条纹大**：条纹本身只有 4px 高，直接拿它当按钮会点不准；
 *   外层按钮做到 10px，缝隙里也能点中。
 * - **提示不用原生 title**：原生提示有约 1 秒系统延迟，用户感觉"移上去没反应"。
 *   这里自己做，出现即显示，且要向左展开（右侧没空间）。
 * - **提示必须走 portal**：导轨自身有 overflow 与 transform，子元素的浮层会被裁掉。
 *
 * 颜色全部走主题令牌（--mt-accent-500 / --mt-surface-*），换主题自动跟随。
 */

import React, { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import styles from './UserInputRail.module.css'

export interface UserInputRailItem {
  id: string
  text: string
}

export interface UserInputRailProps {
  items: readonly UserInputRailItem[]
  onJump: (messageId: string) => void
  /** 视口里当前所在的那条用户消息（条纹高亮） */
  activeId?: string | null
}

/** 悬停预览：前 20 个字符（换行/连续空白压成单个空格，否则预览里全是空白） */
function previewOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 20 ? `${flat.slice(0, 20)}…` : flat
}

interface TooltipState {
  text: string
  top: number
  left: number
}

export const UserInputRail: React.FC<UserInputRailProps> = ({ items, onJump, activeId }) => {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  /** 关闭延迟用的计时器：在条纹之间平移时不该闪断再重开 */
  const hideTimerRef = useRef<number | null>(null)

  const showTooltip = useCallback((element: HTMLElement, text: string) => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current)
      hideTimerRef.current = null
    }
    const rect = element.getBoundingClientRect()
    setTooltip({ text, top: rect.top + rect.height / 2, left: rect.left })
  }, [])

  const hideTooltip = useCallback(() => {
    if (hideTimerRef.current !== null) return
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null
      setTooltip(null)
    }, 40)
  }, [])

  if (items.length <= 1) return null

  return (
    <nav className={styles['rail']} aria-label="我发过的消息">
      {items.map((item, index) => {
        const preview = previewOf(item.text)
        const active = item.id === activeId
        return (
          <button
            type="button"
            key={item.id}
            className={active ? `${styles['stripe']} ${styles['stripe--active']}` : styles['stripe']}
            aria-label={`跳到第 ${index + 1} 条我发的消息：${preview}`}
            aria-current={active ? 'true' : undefined}
            onClick={() => onJump(item.id)}
            onMouseEnter={(e) => showTooltip(e.currentTarget, preview)}
            onMouseLeave={hideTooltip}
            onFocus={(e) => showTooltip(e.currentTarget, preview)}
            onBlur={hideTooltip}
          >
            <span className={styles['stripe-bar']} aria-hidden />
          </button>
        )
      })}

      {tooltip &&
        createPortal(
          <div
            className={styles['tooltip']}
            role="tooltip"
            style={{ top: tooltip.top, left: tooltip.left }}
          >
            {tooltip.text}
          </div>,
          document.body,
        )}
    </nav>
  )
}
