/**
 * 视觉风格库。
 *
 * 五套先做：它们代表了「暗底精确线 / 手绘 / 现代简洁 / 图解 / 科技」五种基本盘。
 * 每套都是**真实的设计工作**——配色、字号、线宽、质感各自调过，不是换个主色。
 *
 * 规则来源：
 * - `3b1b` / `chalkboard` 的调性与禁忌取自 SenseNova 的 `stylized-looks.md`
 *   与 frametell 的 `GRAMMAR.md`（「黑板：粉笔线略粗、略带抖动；不要发光的
 *   浅色块」「白板：马克笔亮色、粗黑线」）
 * - `clean` 取自 explainroo 的 `clean` look（产品/商业向，白底深线一个强调色）
 * - `metro` 取自 frametell 的 `metro`（线路图：原色线路、圆点站点、白底）
 * - `tech-dark` 取自 frametell 的 `tech-dark`（开发者工具向的暗色）
 */

import type { VisualStyle } from './types'

export type { VisualStyle, StyleTheme } from './types'

export const style3b1b: VisualStyle = {
  id: '3b1b',
  name: '3Blue1Brown',
  summary: '近黑深蓝底、细亮线、三四个饱和强调色',
  whenToUse: '数学、物理、算法这类需要精确线条与公式的主题。默认风格。',
  keywords: ['数学', '物理', '公式', '几何', '算法'],
  theme: {
    // 不用纯黑：3B1B 的底是带蓝的近黑，纯黑会让浅蓝发灰
    bg: '#0d1017',
    lectureBg: 'transparent',
    divider: '#1d2433',
    text: '#e8edf4',
    muted: '#4a5568',
    title: '#7dd3fc',
    accent: '#7dd3fc',
    glow: '0 0 20px rgba(125,211,252,.5)',
    element: '#93c5fd',
    lectureSize: 23,
    titleSize: 25,
    elementSize: 26,
    texSize: 34,
    fontFamily: '"Microsoft YaHei", system-ui, sans-serif',
    strokeWidth: 2,
    radius: 4,
    texture: '',
    bulletStyle: 'number',
  },
}

export const styleChalkboard: VisualStyle = {
  id: 'chalkboard',
  name: '黑板',
  summary: '绿黑板、粉笔白、浅色粉笔最多两支',
  whenToUse: '教学推导、课堂讲解。强调「一步一步写在黑板上」的感觉，前面写的不擦。',
  keywords: ['课堂', '推导', '证明', '教学'],
  theme: {
    // 不是纯绿：真实黑板是偏冷的深墨绿，纯绿会让白色粉笔发荧光
    bg: '#1c2b26',
    lectureBg: 'transparent',
    divider: '#2f4239',
    text: '#eef2ef',
    muted: '#5a6b62',
    title: '#f5f0d8',
    accent: '#f5f0d8',
    // 粉笔的发光是「灰白的模糊」，不是彩色辉光
    glow: '0 0 12px rgba(240,240,225,.4)',
    element: '#e8e4d0',
    lectureSize: 24,
    titleSize: 26,
    elementSize: 27,
    texSize: 34,
    // 粉笔字用更朴素的字体，不要现代无衬线
    fontFamily: '"KaiTi", "Microsoft YaHei", serif',
    strokeWidth: 3.5,
    radius: 2,
    // 极淡的纸灰纹理：没有这层，深绿会显得像塑料
    texture:
      'radial-gradient(circle at 30% 20%, rgba(255,255,255,.025) 0 1px, transparent 1px), radial-gradient(circle at 70% 60%, rgba(255,255,255,.02) 0 1px, transparent 1px)',
    bulletStyle: 'number',
  },
}

export const styleClean: VisualStyle = {
  id: 'clean',
  name: '简洁白',
  summary: '白底、深色线条、一个强调色',
  whenToUse: '产品介绍、商业解读、面向大众的科普。投影或亮环境下最清楚。',
  keywords: ['产品', '商业', '简洁', '白底', '明亮'],
  theme: {
    bg: '#ffffff',
    lectureBg: '#fafafa',
    divider: '#e5e7eb',
    text: '#1f2937',
    muted: '#9ca3af',
    title: '#2563eb',
    accent: '#2563eb',
    // 白底不能用发光：会糊成一片灰
    glow: 'none',
    element: '#3b82f6',
    lectureSize: 23,
    titleSize: 25,
    elementSize: 26,
    texSize: 34,
    fontFamily: '"Microsoft YaHei", system-ui, sans-serif',
    strokeWidth: 2.5,
    radius: 8,
    texture: '',
    bulletStyle: 'dot',
  },
}

export const styleMetro: VisualStyle = {
  id: 'metro',
  name: '线路图',
  summary: '白底、粗彩色线路、圆点站点',
  whenToUse: '决策路径、分诊就医、技术选型、排查流程——任何「走到岔路口」的内容。',
  keywords: ['路线', '分岔', '选择', '流程', '路径'],
  theme: {
    // 线路图的纸是偏暖的米白，不是纯白——纯白会显得像 UI 截图
    bg: '#f7f6f1',
    lectureBg: '#f0eee7',
    divider: '#d8d4c8',
    text: '#1a1a1a',
    muted: '#8a8578',
    title: '#0a6fc2',
    accent: '#e1251b',
    glow: 'none',
    element: '#0a6fc2',
    lectureSize: 23,
    titleSize: 25,
    elementSize: 25,
    texSize: 32,
    fontFamily: '"Microsoft YaHei", "Helvetica Neue", sans-serif',
    // 线路图的线是粗的（地铁图的关键特征）
    strokeWidth: 4,
    radius: 0,
    texture: '',
    bulletStyle: 'dot',
  },
}

export const styleTechDark: VisualStyle = {
  id: 'tech-dark',
  name: '科技暗色',
  summary: '深灰底、青绿高亮、等宽字体',
  whenToUse: '技术讲解、开发者工具、架构说明、代码相关主题。',
  keywords: ['技术', '代码', '架构', '开发', 'IT', '系统'],
  theme: {
    bg: '#14161a',
    lectureBg: '#181b20',
    divider: '#2a2f38',
    text: '#e5e7eb',
    muted: '#565d6b',
    title: '#22d3ee',
    accent: '#22d3ee',
    glow: '0 0 16px rgba(34,211,238,.35)',
    element: '#22d3ee',
    lectureSize: 22,
    titleSize: 24,
    elementSize: 24,
    texSize: 32,
    // 技术向用等宽字体，公式与代码看起来更「工程」
    fontFamily: '"Cascadia Mono", Consolas, "Microsoft YaHei", monospace',
    strokeWidth: 2,
    radius: 3,
    // 极淡的网格：暗示「技术图纸」，但不能抢内容
    texture:
      'linear-gradient(rgba(255,255,255,.012) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.012) 1px, transparent 1px)',
    bulletStyle: 'number',
  },
}

export const STYLES: readonly VisualStyle[] = [
  style3b1b,
  styleChalkboard,
  styleClean,
  styleMetro,
  styleTechDark,
]

export function getStyle(id: string | undefined): VisualStyle | undefined {
  return id ? STYLES.find((s) => s.id === id) : undefined
}

/** 默认风格：没有指定时用它（与首版行为一致，只是配色从纯黑换成了 3B1B 的近黑） */
export const DEFAULT_STYLE = style3b1b

/**
 * 按关键词匹配风格。
 *
 * 与结构模板的匹配同一思路：只看第一句、按打分选最优。都匹配不到就返回默认风格
 * （而不是 null）——画面总得有个配色。
 */
export function matchStyleByKeyword(text: string): VisualStyle {
  if (!text?.trim()) return DEFAULT_STYLE
  const trimmed = text.trim()
  const stop = trimmed.search(/[。！？!?\n\r]/)
  const head = (stop > 0 ? trimmed.slice(0, stop) : trimmed).slice(0, 80).toLowerCase()

  let best: { style: VisualStyle; score: number } | null = null
  for (const style of STYLES) {
    const hits = style.keywords.filter((k) => head.includes(k.toLowerCase()))
    if (hits.length === 0) continue
    const score = hits.length * 10 + hits.reduce((n, k) => n + k.length, 0)
    if (!best || score > best.score) best = { style, score }
  }
  return best?.style ?? DEFAULT_STYLE
}
