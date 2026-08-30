/**
 * Wiki 目录面包屑：section → category → subtopic
 */
import type { WikiNav } from './WikiLeftNav'
import {
  legacyCategoriesForSection,
  navSectionFromLegacyCategory,
  navSectionLabel,
  type WikiNavSection,
} from './wikiNavMapping'

/** 单个面包屑节点；有 nav 时可点击返回上级 */
export interface WikiBreadcrumbItem {
  readonly label: string
  readonly nav?: WikiNav
}

type BrowsableSection = 'work' | 'study' | 'life' | 'collection'

/**
 * 判断分区是否属于左栏可浏览的四大用途目录。
 */
function isBrowsableSection(section: WikiNavSection): section is BrowsableSection {
  return section === 'work' || section === 'study' || section === 'life' || section === 'collection'
}

/**
 * 根据当前导航状态生成分级面包屑；非目录浏览视图返回 null。
 */
export function buildWikiBreadcrumbs(nav: WikiNav): readonly WikiBreadcrumbItem[] | null {
  if (nav.kind === 'section' && isBrowsableSection(nav.name)) {
    return [{ label: navSectionLabel(nav.name) }]
  }

  if (nav.kind === 'category') {
    const section = navSectionFromLegacyCategory(nav.name)
    const items: WikiBreadcrumbItem[] = []
    if (isBrowsableSection(section)) {
      items.push({
        label: navSectionLabel(section),
        nav: { kind: 'section', name: section },
      })
    }
    items.push({ label: nav.name })
    return items
  }

  if (nav.kind === 'subtopic') {
    const section = navSectionFromLegacyCategory(nav.category)
    const items: WikiBreadcrumbItem[] = []
    if (isBrowsableSection(section)) {
      items.push({
        label: navSectionLabel(section),
        nav: { kind: 'section', name: section },
      })
    }
    const categoriesInSection = isBrowsableSection(section)
      ? legacyCategoriesForSection(section)
      : []
    if (categoriesInSection.length > 1) {
      items.push({
        label: nav.category,
        nav: { kind: 'category', name: nav.category },
      })
    }
    items.push({ label: nav.subtopic })
    return items
  }

  return null
}
