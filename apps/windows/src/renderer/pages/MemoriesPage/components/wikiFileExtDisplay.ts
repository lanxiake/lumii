/**
 * Wiki 文件列表：后缀解析与手绘笔记风格着色
 *
 * 色板刻意低饱和、略偏暖，贴近纸面手账而非高对比 UI 霓虹色。
 *
 * 色值走 `--mt-file-*` 令牌（定义在 design-system.css 三个主题块）：
 * light 与 eye-care 用同一组浅色原值——实测它们在各自底色上对比度
 * 3.46~5.74、与底色 ΔE ≥ 49，本来就没有问题；**dark 用亮化版**
 * （色相不变、只提明度），因为原值在深底上有 7 个落到 2.55~3.00。
 *
 * 刻意**不**跟随主题变暖：手账色与米黄底正是靠冷暖差才立得住，
 * 整体暖化会与 eye-care 背景糊在一起（见 14 片文档）。
 *
 * 这里返回 `var(...)` 字符串——消费点是 DOM 内联 style（`style={{ color }}`），
 * 天然支持 CSS 变量，无需读计算值。
 */

/** 大类图标色（手绘笔记风） */
const MEDIA_ICON_COLORS: Readonly<Record<string, string>> = {
  document: 'var(--mt-file-other)', // 赭石
  image: 'var(--mt-file-image)', // 砖红
  audio: 'var(--mt-file-audio)', // 青绿
  video: 'var(--mt-file-video)', // 葡萄紫
}

const DEFAULT_INK = 'var(--mt-file-txt)' // 石墨灰

/**
 * 后缀徽章色：同大类内可区分，整体仍偏纸面手账
 */
const EXT_BADGE_COLORS: Readonly<Record<string, string>> = {
  // 文档族：赭石 / 墨绿 / 靛蓝 / 砖褐
  md: 'var(--mt-file-doc)',
  markdown: 'var(--mt-file-doc)',
  txt: 'var(--mt-file-ink)',
  log: 'var(--mt-file-ink)',
  pdf: 'var(--mt-file-pdf)',
  doc: 'var(--mt-file-office)',
  docx: 'var(--mt-file-office)',
  rtf: 'var(--mt-file-office)',
  xls: 'var(--mt-file-sheet)',
  xlsx: 'var(--mt-file-sheet)',
  csv: 'var(--mt-file-sheet)',
  ppt: 'var(--mt-file-slide)',
  pptx: 'var(--mt-file-slide)',
  json: 'var(--mt-file-code)',
  html: 'var(--mt-file-code)',
  htm: 'var(--mt-file-code)',
  // 图片族：砖红 / 琥珀
  png: 'var(--mt-file-image)',
  jpg: 'var(--mt-file-image-2)',
  jpeg: 'var(--mt-file-image-2)',
  gif: 'var(--mt-file-image-3)',
  webp: 'var(--mt-file-image-3)',
  svg: 'var(--mt-file-image-3)',
  bmp: 'var(--mt-file-image-2)',
  // 音视频：青绿 / 葡萄紫
  mp3: 'var(--mt-file-audio)',
  m4a: 'var(--mt-file-audio)',
  wav: 'var(--mt-file-audio-2)',
  flac: 'var(--mt-file-audio-2)',
  ogg: 'var(--mt-file-audio)',
  mp4: 'var(--mt-file-video)',
  mov: 'var(--mt-file-video)',
  webm: 'var(--mt-file-video-2)',
  mkv: 'var(--mt-file-video-2)',
}

/**
 * 从路径或文件名解析扩展名（小写、不含点）；无有效后缀时返回 null。
 */
export function resolveWikiFileExt(sourcePath: string | null | undefined, title: string): string | null {
  const fromPath = extractExt(sourcePath ?? '')
  if (fromPath) return fromPath
  return extractExt(title)
}

/**
 * 标题是否已包含该后缀（避免徽章与标题重复展示）。
 */
export function shouldShowWikiExtBadge(title: string, ext: string | null): boolean {
  if (!ext) return false
  const lower = title.trim().toLowerCase()
  return !lower.endsWith(`.${ext.toLowerCase()}`)
}

/**
 * 徽章文案：大写扩展名。
 */
export function formatWikiExtBadgeLabel(ext: string): string {
  return ext.toUpperCase()
}

/**
 * 按 mediaType 返回图标颜色。
 */
export function wikiMediaTypeIconColor(mediaType: string | null | undefined): string {
  if (!mediaType) return DEFAULT_INK
  return MEDIA_ICON_COLORS[mediaType] ?? DEFAULT_INK
}

/**
 * 按文件后缀返回徽章颜色。
 */
export function wikiFileExtBadgeColor(ext: string): string {
  const key = ext.toLowerCase()
  return EXT_BADGE_COLORS[key] ?? DEFAULT_INK
}

/**
 * 从 basename 提取扩展名；忽略以点开头的隐藏名（无扩展名）。
 * 先剥掉 vault 侧车后缀（.lumii-ref / .url.lumii-ref）——它们是引用指针不是真正的文件后缀，
 * 否则列表里每个 ref 文件都会错误地展示成同一个「LUMII-REF」徽章（与 wiki-display-title 的
 * originalFileExtension 口径一致）。
 */
function extractExt(input: string): string | null {
  const normalized = input.replace(/\\/g, '/').trim()
  if (!normalized) return null
  const base = normalized.includes('/') ? normalized.slice(normalized.lastIndexOf('/') + 1) : normalized
  if (!base || base.startsWith('.')) return null
  const stripped = base.replace(/\.(url\.)?lumii-ref$/i, '')
  const dot = stripped.lastIndexOf('.')
  if (dot <= 0 || dot === stripped.length - 1) return null
  return stripped.slice(dot + 1).toLowerCase()
}
