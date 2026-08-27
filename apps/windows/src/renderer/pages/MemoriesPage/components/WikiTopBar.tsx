import React from 'react'
import { Search, X } from 'lucide-react'

interface WikiTopBarProps {
  title: string
  subtitle: string
  query: string
  onQueryChange: (query: string) => void
  onSearch: () => void
  onClearSearch?: () => void
  pillText: string | null
  pillTone: 'running' | 'success' | 'error' | 'idle'
  onOpenTasks: () => void
}

/**
 * 渲染 Wiki 工作区顶栏，集中承载搜索、分区上下文与任务状态。
 */
export const WikiTopBar: React.FC<WikiTopBarProps> = ({
  title,
  subtitle,
  query,
  onQueryChange,
  onSearch,
  onClearSearch,
  pillText,
  pillTone,
  onOpenTasks,
}) => {
  /**
   * 提交搜索表单，并阻止浏览器刷新当前设置页。
   */
  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    onSearch()
  }

  return (
    <header className="wiki-top-bar">
      <form className="wiki-top-bar-search" role="search" onSubmit={handleSubmit}>
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          placeholder="搜索 Wiki…"
          aria-label="搜索 Wiki"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            onSearch()
          }}
        />
        {query && onClearSearch && (
          <button type="button" className="wiki-top-bar-clear" onClick={onClearSearch} aria-label="清除搜索">
            <X size={13} />
          </button>
        )}
      </form>

      <div className="wiki-top-bar-heading">
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>

      <div className="wiki-top-bar-tasks">
        {pillText && (
          <button
            type="button"
            className={`wiki-task-pill wiki-task-pill--${pillTone}`}
            onClick={onOpenTasks}
          >
            <span className="wiki-task-pill-dot" aria-hidden="true" />
            {pillText}
          </button>
        )}
      </div>
    </header>
  )
}

export default WikiTopBar
