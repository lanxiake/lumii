import React from 'react'
import { HelpCircle, Search, X } from 'lucide-react'
import { Tooltip } from '../../../components/ui/Tooltip/Tooltip'
import { WIKI_SEARCH_TOOLTIP, WIKI_TASK_PILL_TOOLTIP } from './wikiTooltips'
import { WikiBreadcrumb } from './WikiBreadcrumb'
import type { WikiNav } from './WikiLeftNav'
import type { WikiBreadcrumbItem } from './wikiBreadcrumbs'
import styles from './WikiTopBar.module.css'

interface WikiTopBarProps {
  title: string
  subtitle: string
  breadcrumbs?: readonly WikiBreadcrumbItem[] | null
  breadcrumbSuffix?: string
  onBreadcrumbNavigate?: (nav: WikiNav) => void
  /** 已确认的搜索条件（点击路径/标签或回车加入），渲染为可删除芯片 */
  terms: readonly string[]
  /** 输入框草稿，回车后转为条件 */
  draft: string
  onDraftChange: (draft: string) => void
  onSubmit: () => void
  onRemoveTerm: (term: string) => void
  onClearSearch?: () => void
  pillText: string | null
  pillTone: 'running' | 'success' | 'error' | 'idle'
  onOpenTasks: () => void
  onOpenHelp?: () => void
}

/** 任务胶囊色调 → 模块类名（idle 无对应样式，渲染为空） */
const TASK_PILL_TONE_CLASS: Record<WikiTopBarProps['pillTone'], string> = {
  running: styles['wiki-task-pill--running'],
  success: styles['wiki-task-pill--success'],
  error: styles['wiki-task-pill--error'],
  idle: '',
}

/**
 * 渲染 Wiki 工作区顶栏，集中承载搜索、分区上下文与任务状态。
 * 搜索区为「芯片 + 输入」的多条件控件：已确认条件以芯片包裹在输入框内，可单独删除。
 */
export const WikiTopBar: React.FC<WikiTopBarProps> = ({
  title,
  subtitle,
  breadcrumbs,
  breadcrumbSuffix,
  onBreadcrumbNavigate,
  terms,
  draft,
  onDraftChange,
  onSubmit,
  onRemoveTerm,
  onClearSearch,
  pillText,
  pillTone,
  onOpenTasks,
  onOpenHelp,
}) => {
  /**
   * 提交搜索表单，并阻止浏览器刷新当前设置页。
   */
  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    onSubmit()
  }

  const hasCondition = terms.length > 0 || draft.trim().length > 0

  return (
    <header className={styles['wiki-top-bar']}>
      <Tooltip content={WIKI_SEARCH_TOOLTIP} placement="bottom">
        <form className={styles['wiki-top-bar-search']} role="search" onSubmit={handleSubmit}>
          <Search size={14} aria-hidden="true" />
          <div className={styles['wiki-search-input-cluster']}>
            {terms.map((term) => (
              <span key={term} className={styles['wiki-search-chip']}>
                <span className={styles['wiki-search-chip-text']}>{term}</span>
                <button
                  type="button"
                  className={styles['wiki-search-chip-remove']}
                  aria-label={`移除筛选 ${term}`}
                  onClick={() => onRemoveTerm(term)}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
            <input
              type="text"
              placeholder={terms.length === 0 ? '搜索 Wiki…' : '添加筛选条件…'}
              aria-label="搜索 Wiki"
              value={draft}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                onSubmit()
              }}
            />
          </div>
          {hasCondition && onClearSearch && (
            <button type="button" className={styles['wiki-top-bar-clear']} onClick={onClearSearch} aria-label="清除搜索">
              <X size={13} />
            </button>
          )}
        </form>
      </Tooltip>

      <div className={styles['wiki-top-bar-heading']}>
        {breadcrumbs && breadcrumbs.length > 0 && onBreadcrumbNavigate ? (
          <WikiBreadcrumb
            items={breadcrumbs}
            suffix={breadcrumbSuffix}
            onNavigate={onBreadcrumbNavigate}
          />
        ) : (
          <h2>{title}</h2>
        )}
        <p>{subtitle}</p>
      </div>

      <div className={styles['wiki-top-bar-actions']}>
        {onOpenHelp && (
          <Tooltip content="打开 Wiki 使用指引与操作说明" placement="bottom">
            <button
              type="button"
              className={styles['wiki-top-bar-help']}
              onClick={onOpenHelp}
              aria-label="使用指引"
            >
              <HelpCircle size={16} />
            </button>
          </Tooltip>
        )}
        <div className={styles['wiki-top-bar-tasks']}>
          {pillText && (
            <Tooltip content={WIKI_TASK_PILL_TOOLTIP} placement="bottom">
              <button
                type="button"
                className={`${styles['wiki-task-pill']} ${TASK_PILL_TONE_CLASS[pillTone]}`}
                onClick={onOpenTasks}
              >
                <span className={styles['wiki-task-pill-dot']} aria-hidden="true" />
                {pillText}
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    </header>
  )
}

export default WikiTopBar
