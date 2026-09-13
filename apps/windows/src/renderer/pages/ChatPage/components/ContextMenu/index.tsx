import React, { useEffect, useRef } from 'react'
import clsx from 'clsx'
import styles from './ContextMenu.module.css'

export interface ContextMenuItem {
  id: string
  label: string
  /** 传 lucide 图标节点；不再用 emoji */
  icon?: React.ReactNode
  danger?: boolean
  disabled?: boolean
  /** 该项上方画一条分隔线（用于「新建」与「清空」分区） */
  separatorBefore?: boolean
  onClick: () => void
}

interface ContextMenuProps {
  items: ContextMenuItem[]
  position: { x: number; y: number }
  onClose: () => void
}

const ContextMenu: React.FC<ContextMenuProps> = ({ items, position, onClose }) => {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    /**
     * 用捕获阶段监听：分组/会话的「⋯」会 stopPropagation，
     * 冒泡阶段的 document 监听收不到，会导致两个菜单叠在一起。
     */
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    document.addEventListener('click', handleClickOutside, true)
    return () => document.removeEventListener('click', handleClickOutside, true)
  }, [onClose])

  // Adjust position to prevent menu from going off-screen
  const adjustedPosition = {
    x: Math.min(position.x, window.innerWidth - 200),
    y: Math.min(position.y, window.innerHeight - items.length * 40),
  }

  return (
    <div
      ref={menuRef}
      className={styles['context-menu']}
      style={{
        left: adjustedPosition.x,
        top: adjustedPosition.y,
      }}
    >
      {items.map((item) => (
        <React.Fragment key={item.id}>
          {item.separatorBefore && <div className={styles['context-menu-separator']} role="separator" />}
          <button
            className={clsx(styles['context-menu-item'], item.danger && styles.danger, item.disabled && styles.disabled)}
            onClick={() => {
              if (!item.disabled) {
                item.onClick()
                onClose()
              }
            }}
            disabled={item.disabled}
          >
            {item.icon && <span className={styles['context-menu-icon']}>{item.icon}</span>}
            <span className={styles['context-menu-label']}>{item.label}</span>
          </button>
        </React.Fragment>
      ))}
    </div>
  )
}

export default ContextMenu
export { ContextMenu }
