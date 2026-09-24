/**
 * 资讯偏好的结构化读写
 *
 * 「灵栖情报」每轮都要按用户偏好吃穿，此前只能去 user-memory.md 里翻自由文本——
 * 偏好写在哪、写成什么形状全凭当轮发挥，下一轮读的时候又得重新理解一遍。
 * 这里给它一个**固定位置 + 固定字段**：`## 资讯偏好` 章节下的四行固定格式。
 *
 * 放在 user-memory.md 而不是新开文件，是因为它本来就是**用户偏好**：
 * 用户在记忆页能直接看到、直接改；`.bak` 备份、注入预算这些既有机制一并继承。
 *
 * 只解析这一个章节，章节外的内容原样保留——用户手写的其它部分不能被我们改写。
 */

/** 固定字段（顺序即渲染顺序）；写死而不是让模型自由起名，否则下一轮又读不准 */
export const NEWS_PREF_FIELDS = ['关注', '少推', '来源偏好', '推送时段'] as const
export type NewsPrefField = (typeof NEWS_PREF_FIELDS)[number]

/** 章节标题 */
const NEWS_PREF_SECTION = '资讯偏好'

/**
 * 规则的**裁决顺序**：同时命中时谁说了算。
 *
 * 这条链此前**没有被定义过**——「关注 AI」与「少推 AI 融资稿」同时命中时谁赢，
 * 全靠模型当轮发挥。没定义的外在表现，正是用户抱怨的那种「说了少推 X 还是推过来」。
 *
 * ⚠️ 它的**性质**要说清楚：这是一条**给情报遵守的约定**，不是代码强制的不变量。
 * 筛选本身由情报（模型）执行，代码不参与裁决——把这个常量放在这里，
 * 是为了让「读这条链的地方只有一处」（提示词、界面、工具返回共用），
 * 而不是因为它被执行引擎读取。
 *
 * 为什么是「少推」压过「关注」：用户说「少推 X」时是**明确排除**，
 * 而「关注 Y」通常是一大片领域；让领域性的偏好盖过点名的排除，
 * 结果就是排除永远不生效。
 */
export const NEWS_PREF_PRIORITY = ['少推', '关注', '来源偏好'] as const

/** 给人看的一句话版本（界面与提示词共用，避免两处措辞漂移） */
export const NEWS_PREF_PRIORITY_SUMMARY = '明确少推 > 明确关注 > 来源偏好 > 默认排序'

/** 一条偏好的分隔符：用「、」与「/」都常见，读的时候都认 */
const ITEM_SEPARATORS = /[、,，/|]/

export type NewsPreferences = Record<NewsPrefField, readonly string[]>

const EMPTY: NewsPreferences = { 关注: [], 少推: [], 来源偏好: [], 推送时段: [] }

/** 章节位置：headerStart = 标题行起点；bodyStart = 标题行之后；end = 下一个 `## ` 行起点 */
function sectionRange(markdown: string): { headerStart: number; bodyStart: number; end: number } | null {
  const lines = markdown.split('\n')
  let headerStart = -1
  let bodyStart = -1
  let offset = 0
  let end = markdown.length
  for (const line of lines) {
    const lineStart = offset
    offset += line.length + 1
    if (headerStart === -1) {
      if (new RegExp(`^##\\s+${NEWS_PREF_SECTION}\\s*$`).test(line.trim())) {
        headerStart = lineStart
        bodyStart = offset
      }
      continue
    }
    if (/^##\s+\S/.test(line)) {
      end = lineStart
      break
    }
  }
  return headerStart === -1 ? null : { headerStart, bodyStart, end }
}

function parseItems(raw: string): string[] {
  return raw
    .split(ITEM_SEPARATORS)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** 读：章节缺失或字段缺失都返回空数组（调用方据此判断「还没记过」） */
export function readNewsPreferences(markdown: string | null): NewsPreferences {
  if (!markdown) return EMPTY
  const range = sectionRange(markdown)
  if (!range) return EMPTY
  const body = markdown.slice(range.bodyStart, range.end)
  const result: Record<NewsPrefField, string[]> = { 关注: [], 少推: [], 来源偏好: [], 推送时段: [] }
  for (const line of body.split('\n')) {
    const m = /^\s*[-*]?\s*([^：:]+)[：:]\s*(.*)$/.exec(line)
    if (!m) continue
    const field = m[1].trim() as NewsPrefField
    if (!NEWS_PREF_FIELDS.includes(field)) continue
    result[field] = parseItems(m[2])
  }
  return result
}

/** 渲染一个章节（四个字段都写上，空字段也留行——下一轮读到空数组就知道是「明确没记」） */
function renderSection(prefs: NewsPreferences): string {
  const lines = [`## ${NEWS_PREF_SECTION}`]
  for (const field of NEWS_PREF_FIELDS) {
    lines.push(`- ${field}：${prefs[field].join('、')}`)
  }
  return lines.join('\n')
}

export interface NewsPrefPatch {
  readonly field: NewsPrefField
  readonly value: string
  /** add：没有才加（去重）；remove：有才删 */
  readonly op: 'add' | 'remove'
}

/**
 * 写：在章节内增删一条，**章节外的内容原样保留**。
 *
 * 章节不存在时追加到文末；存在时整段替换为重新渲染的四行。
 * 不做「智能归并」之类的判断——那正是模型该在提示词里做的事，这里只保证格式稳定。
 */
export function applyNewsPreference(markdown: string, patch: NewsPrefPatch): string {
  const value = patch.value.trim()
  if (!value) throw new Error('偏好内容不能为空')
  const current = readNewsPreferences(markdown)
  const list = [...current[patch.field]]
  const idx = list.indexOf(value)
  if (patch.op === 'add') {
    if (idx === -1) list.push(value)
  } else if (idx !== -1) {
    list.splice(idx, 1)
  }
  const next: NewsPreferences = { ...current, [patch.field]: list }
  const rendered = renderSection(next)

  const range = sectionRange(markdown)
  if (!range) {
    const base = markdown.replace(/\s+$/, '')
    return `${base}${base ? '\n\n' : ''}${rendered}\n`
  }
  // 标题行之前的部分原样保留（去掉尾部空白，由 rendered 自己带标题）
  const head = markdown.slice(0, range.headerStart).replace(/\s+$/, '')
  const tail = markdown.slice(range.end).replace(/^\n+/, '')
  return `${head}${head ? '\n\n' : ''}${rendered}\n${tail ? `\n${tail}` : ''}`
}

/** 给 prompt 用的一行摘要：读到的偏好直接拼成可注入的一句话 */
export function describeNewsPreferences(prefs: NewsPreferences): string {
  const parts = NEWS_PREF_FIELDS.filter((f) => prefs[f].length > 0).map(
    (f) => `${f}：${prefs[f].join('、')}`,
  )
  return parts.length > 0 ? parts.join('；') : '（尚未记录任何资讯偏好）'
}
