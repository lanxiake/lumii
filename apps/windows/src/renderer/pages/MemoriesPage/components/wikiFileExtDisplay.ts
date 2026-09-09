/**
 * Wiki 文件列表：后缀解析与手绘笔记风格着色
 *
 * 色板刻意低饱和、略偏暖，贴近纸面手账而非高对比 UI 霓虹色。
 */

/** 大类图标色（手绘笔记风） */
const MEDIA_ICON_COLORS: Readonly<Record<string, string>> = {
  document: '#8B7355', // 赭石
  image: '#C0785A', // 砖红
  audio: '#5B8A7A', // 青绿
  video: '#7A6B8A', // 葡萄紫
}

const DEFAULT_INK = '#6B6560' // 石墨灰

/**
 * 后缀徽章色：同大类内可区分，整体仍偏纸面手账
 */
const EXT_BADGE_COLORS: Readonly<Record<string, string>> = {
  // 文档族：赭石 / 墨绿 / 靛蓝 / 砖褐
  md: '#7A6F4D',
  markdown: '#7A6F4D',
  txt: '#6B7F6A',
  log: '#6B7F6A',
  pdf: '#A65D4F',
  doc: '#5B6B8A',
  docx: '#5B6B8A',
  rtf: '#5B6B8A',
  xls: '#6A7A5B',
  xlsx: '#6A7A5B',
  csv: '#6A7A5B',
  ppt: '#9A6B5A',
  pptx: '#9A6B5A',
  json: '#5A6B7A',
  html: '#5A6B7A',
  htm: '#5A6B7A',
  // 图片族：砖红 / 琥珀
  png: '#C0785A',
  jpg: '#B87A4A',
  jpeg: '#B87A4A',
  gif: '#A86B6B',
  webp: '#A86B6B',
  svg: '#A86B6B',
  bmp: '#B87A4A',
  // 音视频：青绿 / 葡萄紫
  mp3: '#5B8A7A',
  m4a: '#5B8A7A',
  wav: '#4F7F72',
  flac: '#4F7F72',
  ogg: '#5B8A7A',
  mp4: '#7A6B8A',
  mov: '#7A6B8A',
  webm: '#6F6280',
  mkv: '#6F6280',
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
 */
function extractExt(input: string): string | null {
  const normalized = input.replace(/\\/g, '/').trim()
  if (!normalized) return null
  const base = normalized.includes('/') ? normalized.slice(normalized.lastIndexOf('/') + 1) : normalized
  if (!base || base.startsWith('.')) return null
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return null
  return base.slice(dot + 1).toLowerCase()
}
