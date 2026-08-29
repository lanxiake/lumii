import React, { useMemo, useState } from 'react'
import { Archive, ArrowRightLeft, ExternalLink, Eye, FileText, Image as ImageIcon, Music, Video } from 'lucide-react'
import { Button } from '../../../components/ui/Button/Button'
import type { WikiSourceListItem } from '../../../hooks/business/useWikiPage'
import { formatRelativeTime } from './wikiStatusLabels'

/** 芯片粒度和 media_type 不是一对一：音视频一个芯片覆盖 audio + video 两种类型 */
export type WikiMediaChip = 'all' | 'document' | 'image' | 'av'

const MEDIA_CHIPS: ReadonlyArray<{ key: WikiMediaChip; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'document', label: '文档' },
  { key: 'image', label: '图片' },
  { key: 'av', label: '音视频' },
]

const MEDIA_ICONS = {
  document: FileText,
  image: ImageIcon,
  audio: Music,
  video: Video,
} as const

function matchesChip(mediaType: string | null, chip: WikiMediaChip): boolean {
  if (chip === 'all') return true
  if (chip === 'av') return mediaType === 'audio' || mediaType === 'video'
  return mediaType === chip
}

interface WikiFileListProps {
  items: readonly WikiSourceListItem[]
  /** 空列表提示，随所在视图变化 */
  emptyHint: string
  /** 搜索结果与「全部大类」列表需要显示 大类 / 小类，小类视图内不重复显示 */
  showTopic?: boolean
  /** 临时存放视图用「移出」，正式目录用「移动」 */
  moveLabel?: string
  /** 临时存放视图不再显示「存到临时存放」 */
  showParkAction?: boolean
  showMediaChips?: boolean
  /** 顶栏动作槽：小类视图的「重新编目本小类」「新建笔记」、多选时的批量条都挂这里 */
  headerActions?: React.ReactNode
  /** 新建后高亮该行，帮用户定位刚创建的文件 */
  highlightId?: string | null
  /** 多选（二期）：默认关闭，不影响一期调用点的渲染 */
  selectable?: boolean
  selectedIds?: ReadonlySet<string>
  onToggleSelect?: (id: string) => void
  onToggleSelectAll?: () => void
  onOpen: (item: WikiSourceListItem) => void
  onPreview: (item: WikiSourceListItem) => void
  onMove: (item: WikiSourceListItem) => void
  onPark?: (item: WikiSourceListItem) => void
}

/**
 * 用途目录下的文件列表：一行一个原始文件，支持详情预览与打开原文件。
 */
export const WikiFileList: React.FC<WikiFileListProps> = ({
  items,
  emptyHint,
  showTopic = false,
  moveLabel = '移动',
  showParkAction = true,
  showMediaChips = true,
  headerActions,
  highlightId = null,
  selectable = false,
  selectedIds,
  onToggleSelect,
  onToggleSelectAll,
  onOpen,
  onPreview,
  onMove,
  onPark,
}) => {
  const [chip, setChip] = useState<WikiMediaChip>('all')
  const visible = useMemo(
    () => (showMediaChips ? items.filter((item) => matchesChip(item.mediaType, chip)) : items),
    [items, chip, showMediaChips],
  )

  return (
    <div className="wiki-file-list">
      {(showMediaChips || headerActions || (selectable && visible.length > 0)) && (
        <div className="wiki-file-list-header">
          {selectable && visible.length > 0 && (
            <label className="wiki-file-list-select-all">
              <input
                type="checkbox"
                aria-label="全选"
                checked={visible.every((item) => selectedIds?.has(item.id) ?? false)}
                onChange={() => onToggleSelectAll?.()}
              />
              全选
            </label>
          )}
          {showMediaChips && (
            <div className="wiki-file-list-chips" role="group" aria-label="按文件类型筛选">
              {MEDIA_CHIPS.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  className={`wiki-file-list-chip${chip === key ? ' wiki-file-list-chip--active' : ''}`}
                  aria-pressed={chip === key}
                  onClick={() => setChip(key)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {headerActions && <div className="wiki-file-list-header-actions">{headerActions}</div>}
        </div>
      )}

      {visible.length === 0 ? (
        <p className="wiki-empty-hint">{emptyHint}</p>
      ) : (
        <ul className="wiki-file-list-items">
          {visible.map((item) => {
            const Icon = MEDIA_ICONS[(item.mediaType ?? 'document') as keyof typeof MEDIA_ICONS] ?? FileText
            const topic = item.topicSubtopic
              ? `${item.topicCategory} / ${item.topicSubtopic}`
              : (item.topicCategory ?? '待补分')
            return (
              <li
                key={item.id}
                className={`wiki-file-list-item${item.id === highlightId ? ' wiki-file-list-item--highlight' : ''}`}
              >
                {selectable && (
                  <input
                    type="checkbox"
                    aria-label={`选择 ${item.title}`}
                    checked={selectedIds?.has(item.id) ?? false}
                    onChange={() => onToggleSelect?.(item.id)}
                  />
                )}
                <Icon size={15} className="wiki-file-list-icon" />
                <div className="wiki-file-list-main">
                  <button
                    type="button"
                    className="wiki-file-list-title wiki-file-list-title--link"
                    onClick={() => onPreview(item)}
                  >
                    {item.title}
                  </button>
                  <span className="wiki-file-list-meta">
                    {showTopic && <span className="wiki-file-list-topic">{topic}</span>}
                    {formatRelativeTime(item.updatedAt)}
                  </span>
                </div>
                <div className="wiki-file-list-actions">
                  <Button variant="ghost" size="sm" onClick={() => onPreview(item)}>
                    <Eye size={13} />
                    详情
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => onOpen(item)}>
                    <ExternalLink size={13} />
                    打开
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => onMove(item)}>
                    <ArrowRightLeft size={13} />
                    {moveLabel}
                  </Button>
                  {showParkAction && onPark && (
                    <Button variant="ghost" size="sm" onClick={() => onPark(item)}>
                      <Archive size={13} />
                      存到临时存放
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export default WikiFileList
