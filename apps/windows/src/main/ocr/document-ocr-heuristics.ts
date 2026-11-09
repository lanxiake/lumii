/**
 * 判断文档文字层是否「稀疏到需要 OCR」的启发式。
 */

/** 每页平均字符数低于此值视为扫描件嫌疑（空白页/纯图页） */
export const SPARSE_PDF_CHARS_PER_PAGE = 40

/** 全文绝对字符数低于此值且页数≥1 也视为稀疏 */
export const SPARSE_PDF_ABS_CHARS = 80

export type SparseTextInput = {
  text: string
  pages?: number
  /** 解析器已判定失败/无文本 */
  parseOk?: boolean
}

/**
 * 是否应走扫描件 OCR（文字层不可用或过稀）。
 */
export function shouldOcrSparseDocument(input: SparseTextInput): boolean {
  if (input.parseOk === false) return true
  const text = (input.text ?? '').trim()
  // 去掉我们自己的失败占位文案
  if (/^\[PDF file:.*不包含可提取的文本/.test(text)) return true
  if (!text) return true

  const pages = Math.max(1, input.pages ?? 1)
  if (text.length < SPARSE_PDF_ABS_CHARS) return true
  return text.length / pages < SPARSE_PDF_CHARS_PER_PAGE
}

/**
 * 是否为可直接 OCR 的图片扩展名。
 */
export function isOcrableImagePath(filePath: string): boolean {
  return /\.(png|jpe?g|webp|bmp)$/i.test(filePath)
}
