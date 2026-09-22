/**
 * SelectionToolbar.tsx - 划词浮条
 *
 * 只负责渲染与定位；「有哪些动作」由调用方给（步骤 4 换成动作注册表）。
 * 定位走 floating-position 的 placeFloating，默认贴选区上方，空间不足自动翻下去。
 */

import React, { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { placeFloating, type FloatingPosition } from './floating-position'
import type { SnapshotRect } from './snapshot'
import styles from './SelectionToolbar.module.css'

export interface SelectionBarItem {
  id: string
  label: string
  icon?: React.ReactNode
  disabled?: boolean
  /** disabled 时对用户的说明，走原生 title */
  disabledReason?: string
}

interface SelectionToolbarProps {
  /** 用快照的 anchorRect（末行矩形），不是联合框 */
  anchorRect: SnapshotRect
  items: readonly SelectionBarItem[]
  onAction: (id: string) => void
  /** 交给上层判断「这次点击是不是打在浮条上」 */
  rootRef: React.RefObject<HTMLDivElement>
}

export const SelectionToolbar: React.FC<SelectionToolbarProps> = ({
  anchorRect,
  items,
  onAction,
  rootRef,
}) => {
  const [position, setPosition] = useState<FloatingPosition | null>(null)

  /**
   * 先量后定位。useLayoutEffect 在绘制前跑完，量位置和定位置之间不会被看到。
   */
  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPosition(
      placeFloating(anchorRect, { width, height }, 'top', {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    )
  }, [anchorRect, rootRef])

  return createPortal(
    <div
      ref={rootRef}
      className={styles['selection-toolbar']}
      role="toolbar"
      aria-label="划词操作"
      data-selection-toolbar=""
      style={{
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position ? 'visible' : 'hidden',
      }}
      // 保住选区：不 preventDefault 的话按下的一瞬浏览器就把选区清空了，
      // 动作执行时 getSelection().toString() 已经变空。
      onMouseDown={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={styles['selection-toolbar-item']}
          data-selection-action={item.id}
          disabled={item.disabled}
          title={item.disabled ? (item.disabledReason ?? item.label) : item.label}
          onClick={() => onAction(item.id)}
        >
          {item.icon && <span className={styles['selection-toolbar-icon']}>{item.icon}</span>}
          <span>{item.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  )
}

export default SelectionToolbar
