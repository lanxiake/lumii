/**
 * Wiki 资料预览辅助：区分网页链接与本地文件，并解析原文 URL。
 */

/** 判断字符串是否为 http(s) 链接 */
export function isHttpUrl(value: string | null | undefined): boolean {
  return !!value && /^https?:\/\//i.test(value.trim())
}

/**
 * 从 origin_context 解析「原文链接: …」行（网页检索归档时写入）。
 */
export function parseOriginalUrlFromContext(originContext: string | null | undefined): string | null {
  if (!originContext) return null
  const match = originContext.match(/原文链接:\s*(https?:\/\/\S+)/i)
  return match?.[1] ?? null
}

/**
 * 合并 source_path 与 origin_context，得到可预览的原文 URL。
 */
export function resolveSourceUrl(
  sourcePath: string | null | undefined,
  originContext: string | null | undefined,
): string | null {
  if (isHttpUrl(sourcePath)) return sourcePath!.trim()
  return parseOriginalUrlFromContext(originContext)
}

/** 预览形态：网页内嵌预览，或本地文件预览 */
export type WikiSourcePreviewMode = 'web' | 'file' | 'text-only'

/**
 * 根据路径与 URL 判定预览方式；无本地路径且无 URL 时仅展示摘要文本。
 */
export function resolvePreviewMode(
  sourcePath: string | null | undefined,
  sourceUrl: string | null | undefined,
): WikiSourcePreviewMode {
  if (sourceUrl || isHttpUrl(sourcePath)) return 'web'
  if (sourcePath && !isHttpUrl(sourcePath)) return 'file'
  return 'text-only'
}

/**
 * 从列表项或详情字段解析可预览的网页 URL。
 */
export function resolveItemSourceUrl(
  sourcePath: string | null | undefined,
  sourceUrl?: string | null | undefined,
  originContext?: string | null | undefined,
): string | null {
  if (sourceUrl) return sourceUrl
  if (isHttpUrl(sourcePath)) return sourcePath!.trim()
  return parseOriginalUrlFromContext(originContext)
}

/** 列表项是否为网页链接型资料 */
export function isUrlSourceItem(sourcePath: string | null | undefined): boolean {
  return isHttpUrl(sourcePath)
}
