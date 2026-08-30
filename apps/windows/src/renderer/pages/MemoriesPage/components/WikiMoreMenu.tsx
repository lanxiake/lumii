import React, { useEffect, useRef } from 'react'
import {
  FolderSync,
  FolderTree,
  History,
  Layers3,
  RefreshCw,
  Sparkles,
  Network,
  Briefcase,
  BookOpen,
  Home,
  Star,
} from 'lucide-react'

interface WikiMoreMenuProps {
  readonly open: boolean
  readonly anchorRef?: React.RefObject<HTMLButtonElement>
  readonly onClose: () => void
  readonly onGraph: () => void
  readonly onSection: (name: string) => void
  readonly onHistory: () => void
  readonly onCleanup: () => void
  readonly onSynthesis: () => void
  readonly onRebuild: () => void
  readonly onEditTopicTree: () => void
  readonly onReclassifyAll: () => void
}

const MENU_ITEMS = [
  {
    key: 'graph',
    label: '知识图谱',
    description: '实体关系图谱与来源追溯',
    icon: Network,
  },
  { key: 'divider-1', label: '', description: '', icon: null },
  {
    key: 'work',
    label: '工作',
    description: '做事记录：项目/会议/汇报',
    icon: Briefcase,
  },
  {
    key: 'study',
    label: '学习',
    description: '学习资料：调研材料',
    icon: BookOpen,
  },
  {
    key: 'life',
    label: '生活',
    description: '计划复盘与证件凭据',
    icon: Home,
  },
  {
    key: 'collection',
    label: '收藏',
    description: '模板参考与随笔创作',
    icon: Star,
  },
  { key: 'divider-2', label: '', description: '', icon: null },
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
 * 渲染 Wiki 导航与运维工具菜单。P0 新增：图谱 + 5 个 nav section 入口。
 */
export const WikiMoreMenu: React.FC<WikiMoreMenuProps> = ({
  open,
  anchorRef,
  onClose,
  onGraph,
  onSection,
  onHistory,
  onCleanup,
  onSynthesis,
  onRebuild,
  onEditTopicTree,
  onReclassifyAll,
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

  return (
    <div ref={menuRef} className="wiki-more-menu" role="menu" aria-label="更多工具">
      {MENU_ITEMS.map(({ key, label, description, icon: Icon }) => {
        if (key.startsWith('divider')) {
          return <div key={key} className="wiki-more-menu-divider" />
        }

        const handleClick = () => {
          if (key === 'graph') onGraph()
          else if (['work', 'study', 'life', 'collection'].includes(key)) onSection(key)
          else if (key === 'reclassifyAll') onReclassifyAll()
          else if (key === 'editTopicTree') onEditTopicTree()
          else if (key === 'history') onHistory()
          else if (key === 'cleanup') onCleanup()
          else if (key === 'synthesis') onSynthesis()
          else if (key === 'rebuild') onRebuild()
          onClose()
        }

        return (
          <button
            key={key}
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
        )
      })}
    </div>
  )
}

export default WikiMoreMenu
