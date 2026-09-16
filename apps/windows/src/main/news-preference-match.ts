/**
 * 资讯规则的**代码级**匹配器。
 *
 * 为什么需要它：偏好的**执行**目前由模型做（提示词里给规则，情报自己筛），
 * 但「这条规则会命中什么」必须由代码回答——否则用户写规则永远是盲选。
 * NewsBlur 作者的原话是：用户过去只能先训练、再看整个 feed 的分数变化，
 * 这是**规则训歪的唯一来源**。
 *
 * 两条边界是照抄 NewsBlur 自己的说明，不是我们的取舍：
 *
 * 1. **只对确定值开放**：「融资」「36氪」这种能写成子串的可以匹配；
 *    「标题党」「太水了」这类**判断式描述**没法用子串表达，只能继续交给模型。
 *    所以「没有命中」不等于「这条规则没用」——它可能只是不可预览。
 *
 * 2. **命中 ≠ 会被拦下**。这里回答的是「如果这条规则现在就生效，
 *    历史上的这些条目会被它碰到」，**不回答**「实际拦下了几篇」——
 *    后者要记录被丢弃的条目，而我们没有那份数据（情报只写它推出去的）。
 *    把这两件事混为一谈就会得出「规则没生效」的错误结论：
 *    大部分命中其实是规则写下之前就已经推出去的。
 */

import type { DashboardFeedItem } from './dashboard-feed-store'
import { NEWS_PREF_PRIORITY, type NewsPrefField, type NewsPreferences } from './news-preferences'

/**
 * 可做子串匹配的字段，**顺序即裁决顺序**。
 *
 * 直接从 `NEWS_PREF_PRIORITY` 取而不是另写一份：两处各写一份的话，
 * 界面上的展示顺序迟早会和规则实际生效的次序漂开。
 * `推送时段` 不在此列——它是时间窗，不是关键词，拿它去匹标题毫无意义。
 */
export const MATCHABLE_FIELDS: readonly NewsPrefField[] = NEWS_PREF_PRIORITY

/** 一条规则的命中详情 */
export interface RuleHit {
  readonly title: string
  readonly source: string
  /** 条目时间（epoch ms）；缺省 0 */
  readonly timestamp: number
}

export interface RuleMatch {
  readonly field: NewsPrefField
  readonly value: string
  readonly count: number
  /** 最近命中的若干条（按时间倒序），供界面展开查看 */
  readonly hits: readonly RuleHit[]
}

/** 默认最多回多少条明细——预览是给人看的，不是导出 */
export const MAX_HITS = 10

/** 匹配范围：标题 + 摘要 + 来源。三个都看，是因为「36氪」既可能是来源也可能是话题 */
function haystackOf(item: DashboardFeedItem): string {
  return [item.title, item.summary, item.source].filter(Boolean).join(' ').toLowerCase()
}

/**
 * 单条规则 vs 单条资讯。
 *
 * 空值一律不命中：一个空规则去匹配所有条目，会让人以为规则"命中了一切"。
 */
export function ruleMatchesItem(value: string, item: DashboardFeedItem): boolean {
  const needle = value.trim().toLowerCase()
  if (!needle) return false
  return haystackOf(item).includes(needle)
}

function toHit(item: DashboardFeedItem): RuleHit {
  return {
    title: item.title,
    source: item.source ?? '',
    timestamp: item.timestamp ?? 0,
  }
}

/** 一条规则匹配一批条目 */
export function matchRuleAgainstItems(
  field: NewsPrefField,
  value: string,
  items: readonly DashboardFeedItem[],
  maxHits: number = MAX_HITS,
): RuleMatch {
  const matched = items.filter((item) => ruleMatchesItem(value, item))
  // 新→旧：用户想看的是「最近还会不会撞上」，不是最早那几条
  const sorted = [...matched].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
  return {
    field,
    value,
    count: matched.length,
    hits: sorted.slice(0, maxHits).map(toHit),
  }
}

/**
 * 整份偏好 vs 一批条目。
 *
 * 返回**按优先级链顺序**（见 `NEWS_PREF_PRIORITY`），
 * 这样界面上「先看到少推、再看到关注」，与规则实际生效的次序一致。
 */
export function matchPreferencesAgainstItems(
  prefs: NewsPreferences,
  items: readonly DashboardFeedItem[],
  maxHits: number = MAX_HITS,
): RuleMatch[] {
  const out: RuleMatch[] = []
  for (const field of MATCHABLE_FIELDS) {
    for (const value of prefs[field]) {
      out.push(matchRuleAgainstItems(field, value, items, maxHits))
    }
  }
  return out
}
