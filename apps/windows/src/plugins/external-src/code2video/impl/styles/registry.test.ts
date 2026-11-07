/**
 * 视觉风格的守卫测试。
 *
 * 两件事必须守住：
 * 1. **每种风格真的不一样**——不是换个主色就叫风格。背景、字体、线宽、质感
 *    至少有四项不同，否则它只是在浪费一个 id。
 * 2. **渲染出来的 CSS 真的带上了这个风格的取值**——改了 theme 但没接到
 *    `buildSceneHtml` 里，是这类重构最常见的半成品。
 */
import { describe, expect, it } from 'vitest'

import { buildSceneHtml } from '../render-backend'
import { DEFAULT_STYLE, getStyle, matchStyleByKeyword, STYLES } from './registry'
import type { SceneStep, StoryboardSection } from '../teaching-core'

const section: StoryboardSection = {
  id: 's1',
  title: '测试',
  lectureLines: ['一', '二', '三'],
  animations: ['a', 'b', 'c'],
}

const scene: SceneStep[] = [
  { elements: [{ kind: 'tex', tex: 'a+b=c', x: 20, y: 20, w: 40, h: 12 }] },
]

describe('风格库完整性', () => {
  it('至少有 5 套（需求里的下限）', () => {
    expect(STYLES.length).toBeGreaterThanOrEqual(5)
  })

  it('id 唯一', () => {
    const ids = STYLES.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(STYLES.map((s) => [s.id, s] as const))('%s 的字段完整', (_id, s) => {
    expect(s.name.length).toBeGreaterThan(0)
    expect(s.summary.length).toBeGreaterThan(0)
    expect(s.whenToUse.length).toBeGreaterThan(10)
    expect(s.keywords.length).toBeGreaterThan(0)
    expect(s.theme.bg).toMatch(/^#|transparent/)
    expect(s.theme.fontFamily.length).toBeGreaterThan(0)
    expect(s.theme.lectureSize).toBeGreaterThan(0)
    expect(s.theme.strokeWidth).toBeGreaterThan(0)
  })

  // 这条是「风格不是换色」的机械判据
  it.each(STYLES.map((s) => [s.id, s] as const))('%s 与默认风格有实质区别', (_id, s) => {
    if (s.id === DEFAULT_STYLE.id) return
    const d = DEFAULT_STYLE.theme
    const t = s.theme
    const diffs = [
      t.bg !== d.bg,
      t.fontFamily !== d.fontFamily,
      t.strokeWidth !== d.strokeWidth,
      t.texture !== d.texture,
      t.radius !== d.radius,
      t.bulletStyle !== d.bulletStyle,
      t.title !== d.title,
    ].filter(Boolean).length
    // 至少 4 项不同：换主色 + 换背景 = 2 项，那不算风格
    expect(diffs).toBeGreaterThanOrEqual(4)
  })
})

describe('风格真的被渲染进 HTML', () => {
  it.each(STYLES.map((s) => [s.id, s] as const))('%s 的背景色进了 CSS', (_id, s) => {
    const html = buildSceneHtml(section, scene, s.theme)
    expect(html).toContain(s.theme.bg)
    expect(html).toContain(s.theme.fontFamily)
    expect(html).toContain(`${s.theme.lectureSize}px`)
  })

  it('不同风格产出不同 HTML', () => {
    const a = buildSceneHtml(section, scene, STYLES[0]!.theme)
    const b = buildSceneHtml(section, scene, STYLES[1]!.theme)
    expect(a).not.toBe(b)
  })

  it('不传主题时用默认风格，与显式传默认一致', () => {
    const implicit = buildSceneHtml(section, scene)
    const explicit = buildSceneHtml(section, scene, DEFAULT_STYLE.theme)
    expect(implicit).toBe(explicit)
  })

  it('白底风格不会留下深色底', () => {
    const white = getStyle('clean')!
    const html = buildSceneHtml(section, scene, white.theme)
    expect(html).toContain('#ffffff')
    // 旧硬编码的纯黑底不能残留
    expect(html).not.toContain('background:#000')
  })

  it('圆点风格用 · 而不是数字编号', () => {
    const metro = getStyle('metro')!
    const html = buildSceneHtml(section, scene, metro.theme)
    expect(html).toContain('<span class="idx">·</span>')
  })
})

describe('风格匹配', () => {
  it('技术类关键词命中 tech-dark', () => {
    expect(matchStyleByKeyword('讲讲这个技术架构').id).toBe('tech-dark')
  })

  it('数学类关键词命中 3b1b', () => {
    expect(matchStyleByKeyword('用数学公式推导').id).toBe('3b1b')
  })

  it('线路图关键词命中 metro', () => {
    expect(matchStyleByKeyword('这条路线的选择').id).toBe('metro')
  })

  it('没有命中时返回默认风格而不是 null', () => {
    expect(matchStyleByKeyword('随便什么').id).toBe(DEFAULT_STYLE.id)
    expect(matchStyleByKeyword('').id).toBe(DEFAULT_STYLE.id)
  })

  it('getStyle 按 id 取到，未知返回 undefined', () => {
    expect(getStyle('chalkboard')?.name).toBe('黑板')
    expect(getStyle('nope')).toBeUndefined()
    expect(getStyle(undefined)).toBeUndefined()
  })
})
