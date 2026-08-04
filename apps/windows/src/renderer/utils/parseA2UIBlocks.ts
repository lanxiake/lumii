/**
 * 从消息内容中提取 A2UI JSON 块 和 Artifact 块
 *
 * 识别规则：
 * - ```a2ui ... ```         → a2ui 组件段（关键字后可无换行）
 * - ```json ... ```         → 若内容为 A2UI spec（含已知组件 type）→ a2ui 段
 * - ```artifact:html ...``` → artifact 沙箱段（html/svg/javascript）
 * - 其余文本                → markdown 段
 */

import type { A2UISpec, A2UIComponent } from '../components/A2UIRenderer/types'

/**
 * 递归补全 A2UIComponent 树中缺失或重复的 id。
 * AI 生成的 spec 不保证 id 唯一性，缺失 id 会导致 React key 警告。
 */
function ensureComponentIds(components: A2UIComponent[]): A2UIComponent[] {
  return components.map((comp) => {
    const withId: A2UIComponent = comp.id ? comp : { ...comp, id: crypto.randomUUID() }
    if (withId.type === 'Card' && withId.components) {
      return { ...withId, components: ensureComponentIds(withId.components) }
    }
    if (withId.type === 'List' && withId.items) {
      return { ...withId, items: ensureComponentIds(withId.items) }
    }
    return withId
  })
}

export type ContentSegment =
  | { type: 'markdown'; content: string }
  | { type: 'a2ui'; spec: A2UISpec }
  | { type: 'artifact'; language: string; content: string }

interface RawMatch {
  index: number
  length: number
  segment: ContentSegment
}

/** 与 A2UIRenderer 中注册的组件 type 对齐，用于区分「普通 JSON」与 A2UI spec，避免误渲染 */
const KNOWN_A2UI_COMPONENT_TYPES = new Set<string>([
  'Text',
  'Card',
  'Image',
  'Button',
  'List',
  'Divider',
  'Chart',
  'MathVisualizer',
  'AudioPlayer',
  'VideoPlayer',
  'FilePreview',
  'DataTable',
])

/**
 * 判断解析后的对象是否像 A2UISpec（含至少一个已知组件 type），降低 ```json 误匹配。
 */
export function looksLikeA2UISpec(o: unknown): o is A2UISpec {
  if (!o || typeof o !== 'object') return false
  const components = (o as { components?: unknown }).components
  if (!Array.isArray(components) || components.length === 0) return false
  return components.some((c) => {
    if (!c || typeof c !== 'object') return false
    const t = (c as { type?: unknown }).type
    return typeof t === 'string' && KNOWN_A2UI_COMPONENT_TYPES.has(t)
  })
}

/**
 * 从 JSON 字符串尝试解析为 A2UISpec；失败或不符合形态时返回 null。
 */
export function tryParseA2UISpecFromJson(text: string): A2UISpec | null {
  try {
    const parsed = JSON.parse(text) as unknown
    if (!looksLikeA2UISpec(parsed)) return null
    return { ...parsed, components: ensureComponentIds(parsed.components) }
  } catch {
    return null
  }
}

/**
 * 宽松解析：与 ```a2ui 围栏逻辑一致，只要含 components 数组即视为 A2UI（供 markdown 内 ```a2ui 代码块兜底）。
 */
export function tryParseA2UIBlockBodyLoose(text: string): A2UISpec | null {
  try {
    const spec = JSON.parse(text) as A2UISpec
    if (spec && Array.isArray(spec.components)) {
      return { ...spec, components: ensureComponentIds(spec.components) }
    }
  } catch {
    /* 非 JSON */
  }
  return null
}

function rangesOverlap(aStart: number, aLen: number, bStart: number, bLen: number): boolean {
  const aEnd = aStart + aLen
  const bEnd = bStart + bLen
  return aStart < bEnd && bStart < aEnd
}

function overlapsAnyMatch(matches: RawMatch[], index: number, length: number): boolean {
  return matches.some((m) => rangesOverlap(m.index, m.length, index, length))
}

// 匹配 ```a2ui 块（允许围栏关键字后直接跟 JSON，无需换行）
const A2UI_REGEX = /```a2ui\s*\n?([\s\S]*?)```/g
// 部分模型用 ```json 输出 A2UI spec，需单独识别
const A2UI_JSON_FENCE_REGEX = /```json\s*\n?([\s\S]*?)```/gi
// 匹配 ```artifact:lang 块（如 artifact:html, artifact:svg）
const ARTIFACT_REGEX = /```artifact:(\w+)\s*\n([\s\S]*?)```/g
// 匹配标准 Markdown 代码块中的可预览语言（html/javascript/js/svg）
// AI 通常输出标准代码块而非 artifact: 前缀，此正则确保这些块也进入 iframe 渲染路径
const MARKDOWN_PREVIEWABLE_REGEX = /```(html|javascript|js|svg)\s*\n([\s\S]*?)```/gi

/**
 * 解析消息内容，提取 A2UI 块和 Artifact 块
 *
 * - 普通文本 → { type: 'markdown', content }
 * - ```a2ui JSON ``` → { type: 'a2ui', spec }（JSON 解析失败降级为 markdown）
 * - ```artifact:html ... ``` → { type: 'artifact', language, content }
 */
export function parseA2UIBlocks(content: string): ContentSegment[] {
  const matches: RawMatch[] = []

  // 收集所有 a2ui 匹配
  for (const match of content.matchAll(A2UI_REGEX)) {
    let segment: ContentSegment
    try {
      const spec = JSON.parse(match[1].trim()) as A2UISpec
      if (spec && Array.isArray(spec.components)) {
        segment = { type: 'a2ui', spec: { ...spec, components: ensureComponentIds(spec.components) } }
      } else {
        segment = { type: 'markdown', content: match[0] }
      }
    } catch {
      segment = { type: 'markdown', content: match[0] }
    }
    matches.push({ index: match.index!, length: match[0].length, segment })
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
    // 检查该位置是否已被 artifact: 前缀正则覆盖，避免重复
    const alreadyCovered = matches.some(
      (m) => m.index <= match.index! && m.index + m.length >= match.index! + match[0].length
    )
    if (!alreadyCovered) {
      matches.push({
        index: match.index!,
        length: match[0].length,
        segment: { type: 'artifact', language, content: artifactContent },
      })
    }
  }

  // ```json 围栏内为 A2UI spec 时提升为 a2ui 段（与 ```a2ui 重叠的区间跳过）
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
