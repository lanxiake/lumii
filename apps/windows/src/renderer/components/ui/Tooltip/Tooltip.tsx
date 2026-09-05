/**
 * 通用 Tooltip：通过 Portal 挂到 body，避免被父级 overflow / 层叠上下文裁切。
 */

import React, { ReactElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Ref } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import styles from './Tooltip.module.css'

export type TooltipPlacement = 'top' | 'bottom' | 'left' | 'right'
export type TooltipTrigger = 'hover' | 'click' | 'focus'

export interface TooltipProps {
  content: React.ReactNode
  placement?: TooltipPlacement
  trigger?: TooltipTrigger
  children: ReactElement
  delay?: number
  className?: string
  disabled?: boolean
}

type TooltipCoords = {
  top: number
  left: number
}

const GAP = 8
const VIEWPORT_PAD = 8

/**
 * 根据触发元素与气泡尺寸计算固定定位坐标，并夹紧到视口内。
 */
function computeCoords(
  triggerEl: HTMLElement,
  tipEl: HTMLElement,
  placement: TooltipPlacement,
): TooltipCoords {
  const rect = triggerEl.getBoundingClientRect()
  const tipRect = tipEl.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight

  let top = 0
  let left = 0

  switch (placement) {
    case 'bottom':
      top = rect.bottom + GAP
      left = rect.left + rect.width / 2 - tipRect.width / 2
      break
    case 'left':
      top = rect.top + rect.height / 2 - tipRect.height / 2
      left = rect.left - tipRect.width - GAP
      break
    case 'right':
      top = rect.top + rect.height / 2 - tipRect.height / 2
      left = rect.right + GAP
      break
    case 'top':
    default:
      top = rect.top - tipRect.height - GAP
      left = rect.left + rect.width / 2 - tipRect.width / 2
      break
  }

  left = Math.min(Math.max(VIEWPORT_PAD, left), vw - tipRect.width - VIEWPORT_PAD)
  top = Math.min(Math.max(VIEWPORT_PAD, top), vh - tipRect.height - VIEWPORT_PAD)

  return { top, left }
}

/**
 * Tooltip 组件：悬停/点击/聚焦时在触发元素旁显示说明。
 */
const Tooltip: React.FC<TooltipProps> = ({
  content,
  placement = 'top',
  trigger = 'hover',
  children,
  delay = 200,
  className = '',
  disabled = false,
}) => {
  const [visible, setVisible] = useState(false)
  const [coords, setCoords] = useState<TooltipCoords>({ top: 0, left: 0 })
  const [positionReady, setPositionReady] = useState(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const tipRef = useRef<HTMLDivElement | null>(null)

  /** 显示气泡（带延迟） */
  const showTooltip = useCallback(() => {
    if (disabled) return
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      setPositionReady(false)
      setVisible(true)
    }, delay)
  }, [delay, disabled])

  /** 立即隐藏气泡 */
  const hideTooltip = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    setVisible(false)
    setPositionReady(false)
  }, [])

  /** 根据触发器位置更新气泡坐标 */
  const updatePosition = useCallback(() => {
    const triggerEl = triggerRef.current
    const tipEl = tipRef.current
    if (!triggerEl || !tipEl) return
    setCoords(computeCoords(triggerEl, tipEl, placement))
    setPositionReady(true)
  }, [placement])

  useLayoutEffect(() => {
    if (!visible) return
    updatePosition()
  }, [visible, content, placement, updatePosition])

  useEffect(() => {
    if (!visible) return

    /** 滚动/缩放时同步位置；点击外部关闭（click 模式） */
    const onReposition = () => updatePosition()
    window.addEventListener('scroll', onReposition, true)
    window.addEventListener('resize', onReposition)

    let onDocClick: ((e: MouseEvent) => void) | undefined
    if (trigger === 'click') {
      onDocClick = (e: MouseEvent) => {
        const t = e.target as Node
        if (triggerRef.current?.contains(t) || tipRef.current?.contains(t)) return
        hideTooltip()
      }
      document.addEventListener('mousedown', onDocClick)
    }

    return () => {
      window.removeEventListener('scroll', onReposition, true)
      window.removeEventListener('resize', onReposition)
      if (onDocClick) document.removeEventListener('mousedown', onDocClick)
    }
  }, [visible, trigger, updatePosition, hideTooltip])

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])

  /** 按触发方式组装事件 */
  const getTriggerProps = () => {
    if (trigger === 'hover') {
      return {
        onMouseEnter: showTooltip,
        onMouseLeave: hideTooltip,
      }
    }
    if (trigger === 'click') {
      return {
        onClick: (e: React.MouseEvent) => {
          e.stopPropagation()
          setVisible((v) => {
            if (v) {
              setPositionReady(false)
              return false
            }
            setPositionReady(false)
            return true
          })
        },
      }
    }
    if (trigger === 'focus') {
      return {
        onFocus: showTooltip,
        onBlur: hideTooltip,
      }
    }
    return {}
  }

  // children 自带的 ref 必须与内部 triggerRef 合并转发
  const originalRef = (children as { ref?: Ref<HTMLElement> }).ref
  const mergedRef = useCallback(
    (node: HTMLElement | null) => {
      triggerRef.current = node
      if (typeof originalRef === 'function') {
        originalRef(node)
      } else if (originalRef && typeof originalRef === 'object') {
        ;(originalRef as { current: HTMLElement | null }).current = node
      }
    },
    [originalRef],
  )

  const tooltipNode =
    visible && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={tipRef}
            className={clsx(
              styles.tooltip,
              styles.portal,
              styles[`tooltip-${placement}`],
              styles['tooltip-visible'],
              className,
            )}
            role="tooltip"
            style={{
              top: coords.top,
              left: coords.left,
              visibility: positionReady ? 'visible' : 'hidden',
            }}
          >
            <div className={styles['tooltip-content']}>{content}</div>
            <div className={styles['tooltip-arrow']} />
          </div>,
          document.body,
        )
      : null

  return (
    <span className={styles['tooltip-wrapper']}>
      {React.cloneElement(children, {
        ref: mergedRef,
        ...getTriggerProps(),
      })}
      {tooltipNode}
    </span>
  )
}

export { Tooltip }
export default Tooltip
