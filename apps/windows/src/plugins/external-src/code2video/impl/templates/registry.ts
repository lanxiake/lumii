/**
 * 模板注册表与匹配。
 *
 * 匹配分三级，**先本地、后模型**，尽量不花 token：
 * 1. `keyword`：用户输入命中模板的 keywords，直接定
 * 2. `model`：draft 阶段让模型从候选里选（见 `buildTemplateChoicePrompt`）
 * 3. `fallback`：模型说都不合适，走 `explain`（最通用）或无模板
 */

import { axiomTemplate } from './builtin/axiom'
import { causeTemplate } from './builtin/cause'
import { compareTemplate } from './builtin/compare'
import { dataTemplate } from './builtin/data'
import { deriveTemplate } from './builtin/derive'
import { explainTemplate } from './builtin/explain'
import { howtoTemplate } from './builtin/howto'
import { measureTemplate } from './builtin/measure'
import { patternTemplate } from './builtin/pattern'
import { processTemplate } from './builtin/process'
import { promoTreeTemplate } from './builtin/promo'
import { routeTemplate } from './builtin/route'
import { storyTemplate } from './builtin/story'
import { structureTemplate } from './builtin/structure'
import { timelineTemplate } from './builtin/timeline'
import type { TeachingTemplate, TemplateMatch } from './types'

export type { TeachingTemplate, TemplateMatch }

/**
 * 全部内置模板。
 *
 * 顺序有意义：`explain` 排第一，它是兜底；其余按「教学类 → 商业类」排，
 * 提示词里按这个顺序列给模型。
 */
export const TEMPLATES: readonly TeachingTemplate[] = [
  explainTemplate,
  deriveTemplate,
  compareTemplate,
  measureTemplate,
  patternTemplate,
  processTemplate,
  structureTemplate,
  causeTemplate,
  axiomTemplate,
  timelineTemplate,
  routeTemplate,
  dataTemplate,
  howtoTemplate,
  storyTemplate,
  promoTreeTemplate,
]

export function getTemplate(id: string): TeachingTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id)
}

/**
 * 关键词匹配。
 *
 * 打分规则：命中的关键词越多越优先；同等命中数时，**关键词越长越具体**
 * （「一步步推导」比「什么」有信息量）。不追求准，只求召回——真拿不准时
 * 还有第二级「让模型选」兜着。
 *
 * **只看第一句**：Agent 会把整段详细需求塞进 `topic`，实测一条 400 字的
 * 需求里同时出现「为什么」（命中 explain）和「数据」（命中 pattern）。
 * 匹配被长文本稀释后，任意一个泛词都可能把模板带偏。真正的主题总在**第一句**，
 * 所以按句末标点截断后再匹配。
 *
 * 截断兜底：没有句末标点时取前 `HEAD_CHARS` 字（宁可少看，不要被后半段带偏）。
 */
export function matchTemplateByKeyword(text: string): TemplateMatch | null {
  if (!text?.trim()) return null
  const HEAD_CHARS = 80
  const trimmed = text.trim()
  // 第一个句末标点（中英文）之后的内容不参与匹配
  const stop = trimmed.search(/[。！？!?\n\r]/)
  const head = (stop > 0 ? trimmed.slice(0, stop) : trimmed).slice(0, HEAD_CHARS)
  const hay = head.toLowerCase()

  let best: { template: TeachingTemplate; hits: string[]; score: number } | null = null
  for (const template of TEMPLATES) {
    const hits = template.keywords.filter((k) => hay.includes(k.toLowerCase()))
    if (hits.length === 0) continue
    // 命中数 × 10 + 关键词总长度：两个同分模板里选中更具体的那个
    const score = hits.length * 10 + hits.reduce((n, k) => n + k.length, 0)
    if (!best || score > best.score) best = { template, hits, score }
  }
  return best ? { template: best.template, reason: 'keyword', hits: best.hits } : null
}

/**
 * 模型选择的结果 → 模板。
 *
 * 模型可能给出不存在的 id（幻觉）或说「都不合适」，两种都退回 `explain`。
 * 这不是「容错」而是**有意的降级**：explain 是最通用的骨架，用它比用错模板好。
 */
export function resolveTemplateChoice(choice: string | null | undefined): TemplateMatch {
  const id = choice?.trim().toLowerCase()
  const template = id ? getTemplate(id) : undefined
  if (template) return { template, reason: 'model' }
  return { template: explainTemplate, reason: 'fallback' }
}

/** 给模型看的选择提示词：只列 id/名称/适用场景，不给完整骨架（省 token） */
export function buildTemplateChoicePrompt(topic: string, durationMinutes?: number): string {
  const list = TEMPLATES.map(
    (t) => `- \`${t.id}\`（${t.name}）：${t.whenToUse}`,
  ).join('\n')
  return `你要为一个短视频选一个**论证结构模板**。

主题：${topic}
${durationMinutes ? `时长：约 ${durationMinutes} 分钟` : ''}

## 可选模板

${list}

## 输出

只输出一行 JSON：{"template":"模板id","reason":"一句话说明为什么选它"}
如果确实都不合适，输出 {"template":null,"reason":"..."}。`
}
