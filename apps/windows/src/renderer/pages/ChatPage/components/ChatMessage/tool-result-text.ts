/**
 * 工具结果 → 可读文本。
 *
 * `tool:end` 的 result 是 pi-agent 的结果对象（`{content:[{type:'text',text}], details}`），
 * 直接 `String(result)` 只会得到 `[object Object]`。失败时文本内容多为宿主工具的
 * JSON 载荷（如 `{"ok":false,"error":"media store not available"}`），这里把真正的
 * 错误原因挑出来给用户看。调用方见 index.tsx 的工具卡片与复制正文。
 */

/** 载荷字段转字符串：字符串直接用，对象/数组序列化 */
function toDisplayString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return undefined
    }
  }
  return undefined
}

/** pi-agent 结果对象形状（含 content 数组） */
function isToolResultShape(result: unknown): boolean {
  return (
    !!result &&
    typeof result === 'object' &&
    Array.isArray((result as { content?: unknown }).content)
  )
}

/** 从结果对象提取文本块内容（多个文本块按行拼接；无文本块返回 undefined） */
function extractTextContent(result: unknown): string | undefined {
  if (!isToolResultShape(result)) return undefined
  const content = (result as { content: unknown[] }).content
  const texts = content
    .filter(
      (block): block is { text: string } =>
        !!block &&
        typeof block === 'object' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map((block) => block.text.trim())
    .filter(Boolean)
  return texts.length > 0 ? texts.join('\n') : undefined
}

/**
 * 载荷里取 `error` / `message` 字段（宿主工具失败载荷的两套约定；另有扁平的
 * `{status,message}` 事件载荷，如 image_generate 失败）；取不到返回 undefined。
 */
function pickErrorDetail(payload: Record<string, unknown>): string | undefined {
  return toDisplayString(payload.error) ?? toDisplayString(payload.message)
}

/** 文本是 JSON 对象时解出错误字段；非对象/非 JSON 返回 undefined，交由调用方回退原文 */
function unwrapErrorDetail(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  return pickErrorDetail(parsed as Record<string, unknown>)
}

/**
 * 工具失败时展示给用户的错误文本。
 *
 * 优先取载荷里的 `error` / `message` 字段，取不到就用结果原文；
 * 结果对象里没有文本（只有空 content 数组等）时回退到 `fallback`。
 */
export function extractToolErrorText(result: unknown, fallback = '工具执行失败'): string {
  if (typeof result === 'string') {
    const text = result.trim()
    return text ? (unwrapErrorDetail(text) ?? text) : fallback
  }
  const text = extractTextContent(result)
  if (text) return unwrapErrorDetail(text) ?? text
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    // 扁平对象载荷（宿主事件型结果）：直接读字段，读不到再序列化
    const detail = pickErrorDetail(result as Record<string, unknown>)
    if (detail) return detail
  }
  if (isToolResultShape(result)) return fallback
  return toDisplayString(result) ?? fallback
}
