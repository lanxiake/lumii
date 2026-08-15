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
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    document.addEventListener('click', handleClickOutside)
    return () => document.removeEventListener('click', handleClickOutside)
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
        <button
          key={item.id}
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
      ))}
    </div>
  )
}

export default ContextMenu
export { ContextMenu }
