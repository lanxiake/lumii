/**
 * Wiki nav section 映射：旧 6 分类 → 新 5 区（工作/学习/生活/收藏 + inbox/archived）
 *
 * 设计：docs/design/记忆设计/2026-08-29-wiki-vault-ref-first-design.md §3.2
 * 实施计划：docs/plans/记忆重构/2026-08-29-wiki-vault-p0-implementation.md T4
 */

import { PARKING_CATEGORY } from '@mtbot/agent-runtime/browser'

export type WikiNavSection = 'work' | 'study' | 'life' | 'collection' | 'inbox' | 'archived' | 'unfiled'

/** 主题树只读形态，供展示格式化使用 */
export interface WikiTopicTreeLike {
  readonly categories: ReadonlyArray<{
    readonly name: string
    readonly subtopics: readonly string[]
  }>
}

/**
 * 两列分组计数的 key。
 * 不能用 `/` 拼：小类名本身允许含斜杠（如「项目/任务资料」）。
 * 也不能用空格拼：大类名可能带空格，`「做事 记录」` 会和 `「做事」+「记录」` 撞 key。
 * 直接序列化两列，天然无歧义，且不引入不可见的分隔符。
 */
export function topicCountKey(category: string, subtopic?: string | null): string {
  return subtopic ? JSON.stringify([category, subtopic]) : JSON.stringify([category])
}

/**
 * 旧 topic 分类 → 新 nav section。
 * 临时存放映射到 inbox（设计 §3.4 偏差 D1）。
 */
export function navSectionFromLegacyCategory(category: string): WikiNavSection {
  switch (category) {
    case '做事记录':
      return 'work'
    case '学习资料':
      return 'study'
    case '计划与复盘':
      return 'life'
    case '证件凭据':
      return 'life'
    case '模板参考':
      return 'collection'
    case '随笔创作':
      return 'collection'
    case '临时存放':
      return 'inbox'
    default:
      return 'unfiled'
  }
}

/**
 * Nav section → 显示名称（中文）
 */
export function navSectionLabel(section: WikiNavSection): string {
  switch (section) {
    case 'work':
      return '工作'
    case 'study':
      return '学习'
    case 'life':
      return '生活'
    case 'collection':
      return '收藏'
    case 'inbox':
      return '收件箱'
    case 'archived':
      return '已归档'
    case 'unfiled':
      return '未分类'
  }
}

/**
 * Nav section → 对应的旧分类列表。一个 section 可能对应多个旧分类（如 life、collection）。
 * 用于「点击 section 时查哪些分类的资料」。
 */
export function legacyCategoriesForSection(section: WikiNavSection): readonly string[] {
  switch (section) {
    case 'work':
      return ['做事记录']
    case 'study':
      return ['学习资料']
    case 'life':
      return ['计划与复盘', '证件凭据']
    case 'collection':
      return ['模板参考', '随笔创作']
    case 'inbox':
      return [] // inbox 由 listInbox IPC 单独处理
    case 'archived':
      return [] // archived 由 archived_at IS NOT NULL 过滤
    case 'unfiled':
      return [] // unfiled 由 topic_category IS NULL 过滤
  }
}

/**
 * 判断同一分区内小类名是否对应多个旧大类（如「整合长文」）。
 */
export function isSubtopicAmbiguousInSection(
  tree: WikiTopicTreeLike,
  section: WikiNavSection,
  subtopic: string,
): boolean {
  const legacyNames = legacyCategoriesForSection(section)
  if (legacyNames.length <= 1) return false
  let hits = 0
  for (const cat of tree.categories) {
    if (legacyNames.includes(cat.name) && cat.subtopics.includes(subtopic)) hits += 1
  }
  return hits > 1
}

/**
 * 将 DB 中的旧大类 + 小类格式化为用户可见的「分区 / 小类」文案。
 * 与左栏导航、归档选择器保持一致；跨旧大类的分区在歧义时保留旧大类名。
 */
export function formatTopicDisplay(
  category: string | null,
  subtopic: string | null,
  tree?: WikiTopicTreeLike | null,
): string {
  if (!category) return '收件箱'
  if (category === PARKING_CATEGORY) return '临时存放'

  const section = navSectionFromLegacyCategory(category)
  if (section === 'inbox' || section === 'unfiled') {
    return subtopic ? `${category} / ${subtopic}` : category
  }

  const sectionLabel = navSectionLabel(section)
  const catsInSection = legacyCategoriesForSection(section)

  if (!subtopic) {
    return catsInSection.length <= 1 ? sectionLabel : `${sectionLabel} / ${category}`
  }

  if (catsInSection.length <= 1) {
    return `${sectionLabel} / ${subtopic}`
  }

  if (tree && isSubtopicAmbiguousInSection(tree, section, subtopic)) {
    return `${sectionLabel} / ${category} / ${subtopic}`
  }
  return `${sectionLabel} / ${subtopic}`
}
