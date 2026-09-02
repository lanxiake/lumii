/**
 * Wiki 目录面包屑：大类 → 小类
 *
 * v1.1：左栏分区就是树中的大类，`section` 与 `category` 不再是两层
 * （原先 section 是「旧六大类聚合出的分区」，故有 分区/大类/小类 三级）。
 */
import type { WikiNav } from './WikiLeftNav'
import {
  UNFILED_SUBTOPIC_LABEL,
  WIKI_SUBTOPIC_FILTER_ALL,
  isSystemSection,
  navSectionLabel,
  subtopicFilterLabel,
  type WikiSubtopicFilter,
} from './wikiTopicDisplay'

/** 单个面包屑节点；有 nav 时可点击返回上级 */
export interface WikiBreadcrumbItem {
  readonly label: string
  readonly nav?: WikiNav
}

/**
 * 根据当前导航状态生成分级面包屑；非目录浏览视图返回 null。
 */
export function buildWikiBreadcrumbs(
  nav: WikiNav,
  subtopicFilter: WikiSubtopicFilter = WIKI_SUBTOPIC_FILTER_ALL,
): readonly WikiBreadcrumbItem[] | null {
  // 大类分区：默认单级；筛选到具体小类时补第二级。
  if (nav.kind === 'section' && !isSystemSection(nav.name)) {
    if (subtopicFilter === WIKI_SUBTOPIC_FILTER_ALL) {
      return [{ label: navSectionLabel(nav.name) }]
    }
    return [
      { label: navSectionLabel(nav.name), nav: { kind: 'section', name: nav.name } },
      { label: subtopicFilterLabel(subtopicFilter) },
    ]
  }

  if (nav.kind === 'category') {
    if (subtopicFilter === WIKI_SUBTOPIC_FILTER_ALL) {
      return [{ label: nav.name }]
    }
    return [
      { label: nav.name, nav: { kind: 'section', name: nav.name } },
      { label: subtopicFilterLabel(subtopicFilter) },
    ]
  }

  if (nav.kind === 'subtopic') {
    return [
      { label: nav.category, nav: { kind: 'section', name: nav.category } },
      { label: nav.subtopic ?? UNFILED_SUBTOPIC_LABEL },
    ]
  }

  return null
}
