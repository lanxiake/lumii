/**
 * Wiki nav section 映射：旧 6 分类 → 新 5 区（工作/学习/生活/收藏 + inbox/archived）
 *
 * 设计：docs/design/记忆设计/2026-08-29-wiki-vault-ref-first-design.md §3.2
 * 实施计划：docs/plans/记忆重构/2026-08-29-wiki-vault-p0-implementation.md T4
 */

export type WikiNavSection = 'work' | 'study' | 'life' | 'collection' | 'inbox' | 'archived' | 'unfiled'

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
      return '待整理'
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
