/**
 * Wiki 目录面包屑：大类 → 小类
 *
 * v1.1：左栏分区就是树中的大类，`section` 与 `category` 不再是两层
 * （原先 section 是「旧六大类聚合出的分区」，故有 分区/大类/小类 三级）。
 */
import type { WikiNav } from './WikiLeftNav'
import { UNFILED_SUBTOPIC_LABEL, isSystemSection, navSectionLabel } from './wikiTopicDisplay'

/** 单个面包屑节点；有 nav 时可点击返回上级 */
export interface WikiBreadcrumbItem {
  readonly label: string
  readonly nav?: WikiNav
}

/**
 * 根据当前导航状态生成分级面包屑；非目录浏览视图返回 null。
 */
export function buildWikiBreadcrumbs(nav: WikiNav): readonly WikiBreadcrumbItem[] | null {
  // 大类分区：单级面包屑。系统分区（收件箱/归档）有自己的视图，不走目录面包屑。
  if (nav.kind === 'section' && !isSystemSection(nav.name)) {
    return [{ label: navSectionLabel(nav.name) }]
  }

  if (nav.kind === 'category') {
    return [{ label: nav.name }]
  }

  if (nav.kind === 'subtopic') {
    return [
      { label: nav.category, nav: { kind: 'section', name: nav.category } },
      { label: nav.subtopic ?? UNFILED_SUBTOPIC_LABEL },
    ]
  }

  return null
}
