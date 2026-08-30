import React from 'react'
import {
  FolderSync,
  FolderTree,
  History,
  Layers3,
  RefreshCw,
  Sparkles,
} from 'lucide-react'
import { Switch } from '../../../components/ui/Switch/Switch'
import { Tooltip } from '../../../components/ui/Tooltip/Tooltip'
import { WIKI_MORE_MENU_TOOLTIPS } from './wikiTooltips'

interface WikiMoreMenuProps {
  readonly open: boolean
  readonly anchorRef?: React.RefObject<HTMLButtonElement>
  readonly onClose: () => void
  readonly autoClassifyEnabled: boolean
  readonly onAutoClassifyChange: (enabled: boolean) => void
  readonly onHistory: () => void
  readonly onCleanup: () => void
  readonly onSynthesis: () => void
  readonly onRebuild: () => void
  readonly onEditTopicTree: () => void
  readonly onReclassifyAll: () => void
}

const MENU_ITEMS = [
  {
    key: 'reclassifyAll',
    label: '全库重新编目',
    description: '让 AI 复查已归档文件的目录',
    icon: FolderSync,
  },
  {
    key: 'editTopicTree',
    label: '编辑主题树',
    description: '增删改并大类与小类',
    icon: FolderTree,
  },
  {
    key: 'history',
    label: '历史页面',
    description: '查看早期归档生成的摘要页面',
    icon: History,
  },
  {
    key: 'cleanup',
    label: '清理',
    description: '扫描并处理需要维护的资料',
    icon: RefreshCw,
  },
  {
    key: 'synthesis',
    label: '综述合成',
    description: '从目录里的文件生成主题综述',
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
 * 渲染 Wiki 运维工具菜单；悬停显示详细使用说明。
 */
export const WikiMoreMenu: React.FC<WikiMoreMenuProps> = ({
  open,
  anchorRef,
  onClose,
  autoClassifyEnabled,
  onAutoClassifyChange,
  onHistory,
  onCleanup,
  onSynthesis,
  onRebuild,
  onEditTopicTree,
  onReclassifyAll,
}) => {
  const menuRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
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

  return (
    <div ref={menuRef} className="wiki-more-menu" role="menu" aria-label="更多工具">
      {MENU_ITEMS.map(({ key, label, description, icon: Icon }) => {
        const handleClick = () => {
          if (key === 'reclassifyAll') onReclassifyAll()
          else if (key === 'editTopicTree') onEditTopicTree()
          else if (key === 'history') onHistory()
          else if (key === 'cleanup') onCleanup()
          else if (key === 'synthesis') onSynthesis()
          else if (key === 'rebuild') onRebuild()
          onClose()
        }

        const tooltip = WIKI_MORE_MENU_TOOLTIPS[key] ?? description

        return (
          <Tooltip key={key} content={tooltip} placement="right">
            <button
              type="button"
              className="wiki-more-menu-item"
              role="menuitem"
              onClick={handleClick}
            >
              {Icon && <Icon size={16} />}
              <span>
                <strong>{label}</strong>
                <small>{description}</small>
              </span>
            </button>
          </Tooltip>
        )
      })}
      <div className="wiki-more-menu-divider" role="separator" />
      <Tooltip content={WIKI_MORE_MENU_TOOLTIPS.autoClassify} placement="right">
        <div className="wiki-more-menu-toggle">
          <span>
            <strong>AI 自动分类</strong>
            <small>新资料导入后自动归档到目录</small>
          </span>
          <Switch
            size="sm"
            checked={autoClassifyEnabled}
            onChange={onAutoClassifyChange}
            aria-label="AI 自动分类"
          />
        </div>
      </Tooltip>
    </div>
  )
}

export default WikiMoreMenu
