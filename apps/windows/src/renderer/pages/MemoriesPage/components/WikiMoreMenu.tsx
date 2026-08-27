import React, { useEffect, useRef } from 'react'
import { Layers3, RefreshCw, Sparkles } from 'lucide-react'

interface WikiMoreMenuProps {
  readonly open: boolean
  readonly anchorRef?: React.RefObject<HTMLButtonElement>
  readonly onClose: () => void
  readonly onCleanup: () => void
  readonly onSynthesis: () => void
  readonly onRebuild: () => void
}

const MENU_ITEMS = [
  {
    key: 'cleanup',
    label: '清理',
    description: '扫描并处理需要维护的资料',
    icon: RefreshCw,
  },
  {
    key: 'synthesis',
    label: '综述合成',
    description: '从已有页面生成主题综述',
    icon: Sparkles,
  },
  {
    key: 'rebuild',
    label: '重建索引',
    description: '重新生成全文检索索引',
    icon: Layers3,
  },
] as const

/**
 * 渲染 Wiki 运维工具菜单，并在点击菜单外部时关闭。
 */
export const WikiMoreMenu: React.FC<WikiMoreMenuProps> = ({
  open,
  anchorRef,
  onClose,
  onCleanup,
  onSynthesis,
  onRebuild,
}) => {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return undefined

    /** 在指针落于菜单与触发器之外时关闭菜单。 */
    const handlePointerDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (menuRef.current?.contains(target) || anchorRef?.current?.contains(target)) return
      onClose()
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [anchorRef, onClose, open])

  if (!open) return null

  const actions = {
    cleanup: onCleanup,
    synthesis: onSynthesis,
    rebuild: onRebuild,
  } as const

  return (
    <div ref={menuRef} className="wiki-more-menu" role="menu" aria-label="更多工具">
      {MENU_ITEMS.map(({ key, label, description, icon: Icon }) => (
        <button
          key={key}
          type="button"
          className="wiki-more-menu-item"
          role="menuitem"
          onClick={() => {
            actions[key]()
            onClose()
          }}
        >
          <Icon size={16} />
          <span>
            <strong>{label}</strong>
            <small>{description}</small>
          </span>
        </button>
      ))}
    </div>
  )
}

export default WikiMoreMenu
