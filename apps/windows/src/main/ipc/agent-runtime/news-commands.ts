/**
 * 资讯偏好的**检视**：每条规则会命中哪些已推条目。
 *
 * 起因：用户写规则一直是**盲选**——偏好写进 user-memory.md 之后，
 * 下一轮是否生效、会命中什么，界面上完全看不见。NewsBlur 作者的原话是，
 * 过去只能先训练、再看整个 feed 的分数变化，这是**规则训歪的唯一来源**。
 *
 * 这里同时充当两个角色的**同一个计算**：
 * - 「预览命中集」：写一条新规则前，先看它会碰到哪些历史条目
 * - 「规则日志」：每条规则现在还能命中多少篇
 * 不分成两个实现，是因为它们一旦口径漂开，预览的意义就没了。
 *
 * 边界（照抄 NewsBlur 自己的说明）见 `news-preference-match.ts` 的文件头。
 */

import { readUserMemoryFile } from '../plugin-ipc'
import { readActiveDashboardFeedSnapshot } from '../../dashboard-feed-store'
import {
  NEWS_PREF_FIELDS,
  NEWS_PREF_PRIORITY_SUMMARY,
  readNewsPreferences,
  type NewsPrefField,
} from '../../news-preferences'
import { MATCHABLE_FIELDS, matchPreferencesAgainstItems } from '../../news-preference-match'

export async function handleNewsPreferencePreview(): Promise<unknown> {
  const file = await readUserMemoryFile()
  const prefs = readNewsPreferences(file?.content ?? '')
  const snapshot = await readActiveDashboardFeedSnapshot()
  const items = snapshot?.items ?? []

  return {
    itemCount: items.length,
    prioritySummary: NEWS_PREF_PRIORITY_SUMMARY,
    rules: matchPreferencesAgainstItems(prefs, items),
    // 不可预览的字段如实列出：不列的话，界面上会只剩「推送时段」消失不见，
    // 看起来像丢了数据；列成 0 命中又是在撒谎（它压根不是关键词规则）。
    nonMatchable: NEWS_PREF_FIELDS.filter(
      (field) => !MATCHABLE_FIELDS.includes(field),
    ).map((field: NewsPrefField) => ({ field, values: prefs[field] })),
  }
}
