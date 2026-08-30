/**
 * WikiBreadcrumb — 资料库目录分级导航
 */
import React from 'react'
import { ChevronRight } from 'lucide-react'
import type { WikiNav } from './WikiLeftNav'
import type { WikiBreadcrumbItem } from './wikiBreadcrumbs'

interface WikiBreadcrumbProps {
  readonly items: readonly WikiBreadcrumbItem[]
  /** 追加在当前页标签后，如文件数量 "(12)" */
  readonly suffix?: string
  readonly onNavigate: (nav: WikiNav) => void
}

/**
 * 渲染可点击的目录面包屑，便于从二级小类返回上级分区。
 */
export const WikiBreadcrumb: React.FC<WikiBreadcrumbProps> = ({ items, suffix, onNavigate }) => {
  if (items.length === 0) return null

  return (
    <nav className="wiki-breadcrumb" aria-label="当前位置">
      <ol className="wiki-breadcrumb-list">
        {items.map((item, index) => {
          const isLast = index === items.length - 1
          const canNavigate = Boolean(item.nav) && !isLast

          return (
            <li key={`${item.label}-${index}`} className="wiki-breadcrumb-item">
              {index > 0 && (
                <ChevronRight size={12} className="wiki-breadcrumb-sep" aria-hidden="true" />
              )}
              {canNavigate && item.nav ? (
                <button
                  type="button"
                  className="wiki-breadcrumb-link"
                  onClick={() => onNavigate(item.nav!)}
                >
                  {item.label}
                </button>
              ) : (
                <span className="wiki-breadcrumb-current" aria-current={isLast ? 'page' : undefined}>
                  {item.label}
                  {isLast && suffix ? ` ${suffix}` : ''}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

export default WikiBreadcrumb
