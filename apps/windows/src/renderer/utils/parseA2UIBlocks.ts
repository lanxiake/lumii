/**
 * 从消息内容中提取 A2UI JSON 块 和 Artifact 块
 *
 * 识别规则：
 * - ```a2ui ... ```         → a2ui 组件段（关键字后可无换行，大小写不敏感）
 * - ```json ... ```         → 若内容为 A2UI spec（含已知组件 type）→ a2ui 段
 * - ```artifact:html ...``` → artifact 沙箱段（html/svg/javascript）
 * - ```html/svg/js ...```   → 同样提升为 artifact 段
 * - 其余文本                → markdown 段
 *
 * 所有 A2UI spec 都经过 `normalizeA2UISpec` 收窄：字段类型不对、规模超限的整块
 * 丢弃（降级为 markdown 原文），绝不把半成品交给渲染层。
 */

import { looksLikeA2UISpec, normalizeA2UISpec } from '../components/A2UIRenderer/validate'
import type { A2UISpec } from '../components/A2UIRenderer/types'

export type ContentSegment =
  | { type: 'markdown'; content: string }
  | { type: 'a2ui'; spec: A2UISpec }
  | { type: 'artifact'; language: string; content: string }

interface RawMatch {
  index: number
  length: number
  segment: ContentSegment
}

/**
 * 从 JSON 字符串尝试解析为 A2UISpec；失败或不符合形态时返回 null。
 */
export function tryParseA2UISpecFromJson(text: string): A2UISpec | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  // 先看形态再收窄：普通 JSON 不该被 normalize 的宽松规则抬成 A2UI
  if (!looksLikeA2UISpec(parsed)) return null
  return normalizeA2UISpec(parsed)
}

/**
 * 宽松解析：```a2ui 围栏内的内容，只要含 components 数组就按 A2UI 处理
 *（围栏本身已经是模型的明确意图，不必再要求 type 命中）。
 */
export function tryParseA2UIBlockBodyLoose(text: string): A2UISpec | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  return normalizeA2UISpec(parsed)
}

function rangesOverlap(aStart: number, aLen: number, bStart: number, bLen: number): boolean {
  const aEnd = aStart + aLen
  const bEnd = bStart + bLen
  return aStart < bEnd && bStart < aEnd
}

function overlapsAnyMatch(matches: RawMatch[], index: number, length: number): boolean {
  return matches.some((m) => rangesOverlap(m.index, m.length, index, length))
}

// 匹配 ```a2ui 块（允许围栏关键字后直接跟 JSON，无需换行；大小写不敏感）
const A2UI_REGEX = /```a2ui\s*\n?([\s\S]*?)```/gi
// 部分模型用 ```json 输出 A2UI spec，需单独识别
const A2UI_JSON_FENCE_REGEX = /```json\s*\n?([\s\S]*?)```/gi
// 匹配 ```artifact:lang 块（如 artifact:html, artifact:svg），语言允许连字符
const ARTIFACT_REGEX = /```artifact:([\w-]+)\s*\n([\s\S]*?)```/g
// 匹配标准 Markdown 代码块中的可预览语言（html/javascript/js/svg）
// AI 通常输出标准代码块而非 artifact: 前缀，此正则确保这些块也进入 iframe 渲染路径
const MARKDOWN_PREVIEWABLE_REGEX = /```(html|javascript|js|svg)\s*\n([\s\S]*?)```/gi

/**
 * 解析消息内容，提取 A2UI 块和 Artifact 块
 *
 * - 普通文本 → { type: 'markdown', content }
 * - ```a2ui JSON ``` → { type: 'a2ui', spec }（收窄失败降级为 markdown 原文）
 * - ```artifact:html ... ``` → { type: 'artifact', language, content }
 */
export function parseA2UIBlocks(content: string): ContentSegment[] {
  const matches: RawMatch[] = []

  // 收集所有 a2ui 匹配
  for (const match of content.matchAll(A2UI_REGEX)) {
    const spec = tryParseA2UIBlockBodyLoose(match[1].trim())
    matches.push({
      index: match.index!,
      length: match[0].length,
      segment: spec ? { type: 'a2ui', spec } : { type: 'markdown', content: match[0] },
    })
  }

  // 收集所有 artifact 匹配
  for (const match of content.matchAll(ARTIFACT_REGEX)) {
    const language = match[1].toLowerCase()
    const artifactContent = match[2].trim()
    matches.push({
      index: match.index!,
      length: match[0].length,
      segment: { type: 'artifact', language, content: artifactContent },
    })
  }

  // 收集标准 Markdown 可预览代码块（```html / ```javascript / ```js / ```svg）
  // 将其提升为 artifact，使其进入 IframeArtifact 渲染路径而非纯代码高亮
  for (const match of content.matchAll(MARKDOWN_PREVIEWABLE_REGEX)) {
    const language = match[1].toLowerCase()
    const artifactContent = match[2].trim()
    // 与已收集区间**任一方向**重叠都跳过（原先只判"完全被包含"，部分重叠会重复入列）
    if (overlapsAnyMatch(matches, match.index!, match[0].length)) continue
    matches.push({
      index: match.index!,
      length: match[0].length,
      segment: { type: 'artifact', language, content: artifactContent },
    })
  }

  // ```json 围栏内为 A2UI spec 时提升为 a2ui 段（与已有区间重叠的跳过）
  for (const match of content.matchAll(A2UI_JSON_FENCE_REGEX)) {
    const idx = match.index!
    const len = match[0].length
    if (overlapsAnyMatch(matches, idx, len)) continue
    const spec = tryParseA2UISpecFromJson(match[1].trim())
    if (!spec) continue
    matches.push({ index: idx, length: len, segment: { type: 'a2ui', spec } })
  }

  // 按出现顺序排序
  matches.sort((a, b) => a.index - b.index)

  const segments: ContentSegment[] = []
  let lastIndex = 0

  for (const { index, length, segment } of matches) {
    // 区间回退说明上一段已经越过了这里（理论上不会发生，排序 + 重叠过滤已排除）；
    // 兜底跳过，避免 slice 出重复内容
    if (index < lastIndex) continue
    // 匹配前的纯文本
    if (index > lastIndex) {
      const text = content.slice(lastIndex, index)
      if (text.trim()) {
        segments.push({ type: 'markdown', content: text })
      }
    }
    segments.push(segment)
    lastIndex = index + length
  }

  // 尾部剩余文本
  if (lastIndex < content.length) {
    const text = content.slice(lastIndex)
    if (text.trim()) {
      segments.push({ type: 'markdown', content: text })
    }
  }

  // 无特殊块 → 返回单段 markdown
  if (segments.length === 0 && content.trim()) {
    return [{ type: 'markdown', content }]
  }

  return segments
}
