/**
 * Wiki 主题展示：分区标签、两列展示文案、分组计数 key
 *
 * 取代 `wikiNavMapping.ts`。v2 树的大类名本身就是左栏分区名（工作/学习/生活/收藏），
 * 「旧大类 → nav 分区」这层映射随之消失——左栏、磁盘目录、DB 两列三者一一对应。
 *
 * 设计：docs/design/记忆设计/2026-08-31-wiki-intelligent-vault-design.md v1.1 §2.3、§11
 */

import { PARKING_CATEGORY } from '@mtbot/agent-runtime/browser'

/** 系统分区：不由 topic_category 取值定义，而是 DB 条件（NULL / archived_at / 手动搁置） */
export type WikiSystemSection = 'inbox' | 'archived' | 'unfiled'

/**
 * 左栏分区：系统分区，或树中的大类名。
 *
 * 类型上就是 string——用户可自建大类，分区集合是开放的，不能再写成固定联合类型。
 * 判断某个值是不是系统分区用 `isSystemSection`。
 */
export type WikiNavSection = WikiSystemSection | (string & {})

const SYSTEM_SECTIONS: readonly WikiSystemSection[] = ['inbox', 'archived', 'unfiled']

/** 大类下「有大类无小类」的那组资料在 UI 上的分组名（小类可选，见设计 §2.1.1） */
export const UNFILED_SUBTOPIC_LABEL = '未细分'

/** 大类视图：显示全部文件 */
export const WIKI_SUBTOPIC_FILTER_ALL = '__all__' as const
/** 大类视图：只显示未细分小类的文件 */
export const WIKI_SUBTOPIC_FILTER_UNFILED = '__unfiled__' as const

/** 大类下的小类筛选状态 */
export type WikiSubtopicFilter =
  | typeof WIKI_SUBTOPIC_FILTER_ALL
  | typeof WIKI_SUBTOPIC_FILTER_UNFILED
  | (string & {})

/**
 * 把小类筛选状态格式化为 UI 标签。
 */
export function subtopicFilterLabel(filter: WikiSubtopicFilter): string {
  if (filter === WIKI_SUBTOPIC_FILTER_ALL) return '全部'
  if (filter === WIKI_SUBTOPIC_FILTER_UNFILED) return UNFILED_SUBTOPIC_LABEL
  return filter
}

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
 *
 * 语义必须与 agent-runtime 侧 `wiki-topic-mutate.ts` 的同名函数完全一致。
 */
export function topicCountKey(category: string, subtopic?: string | null): string {
  return subtopic ? JSON.stringify([category, subtopic]) : JSON.stringify([category])
}

/**
 * 解析 topicCountKey。坏 key 返回 null，避免芯片列表被脏计数打穿。
 */
export function parseTopicCountKey(key: string): { category: string; subtopic: string | null } | null {
  try {
    const parsed: unknown = JSON.parse(key)
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 2) return null
    const category = parsed[0]
    if (typeof category !== 'string') return null
    if (parsed.length === 1) return { category, subtopic: null }
    const subtopic = parsed[1]
    if (typeof subtopic !== 'string') return null
    return { category, subtopic }
  } catch {
    return null
  }
}

/** 是否是系统分区（inbox / archived / unfiled），而非树中的大类 */
export function isSystemSection(section: WikiNavSection): section is WikiSystemSection {
  return (SYSTEM_SECTIONS as readonly string[]).includes(section)
}

/**
 * 分区显示名。系统分区给中文标签；大类分区直接用大类名本身
 * （v2 起大类名即展示名，不再有第二套 label）。
 */
export function navSectionLabel(section: WikiNavSection): string {
  switch (section) {
    case 'inbox':
      return '收件箱'
    case 'archived':
      return '已归档'
    case 'unfiled':
      return '未分类'
    default:
      return section
  }
}

/**
 * 把 DB 中的主题两列格式化为用户可见文案。
 * 小类为空是合法状态（小类可选），此时只显示大类名。
 */
export function formatTopicDisplay(category: string | null, subtopic: string | null): string {
  if (!category) return '收件箱'
  if (category === PARKING_CATEGORY) return '临时存放'
  return subtopic ? `${category} / ${subtopic}` : category
}
