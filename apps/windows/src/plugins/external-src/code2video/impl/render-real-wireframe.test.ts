/**
 * 真实产物回归：用**实际生成过的 scene** 验证渲染器。
 *
 * 这一组数据来自 2026-11-07 12:01 的一次真机生成（负数乘法，5 节，模型自动
 * 选了 axis/arrow/tex/curve）。当时渲染出来的数轴刻度数字全压在轴线上——
 * 根因是 SVG 用了 `viewBox="0 0 100 100"` + `preserveAspectRatio="none"`，
 * 非等比拉伸把 13 个数字压成横条。这里把那份真实输入钉下来，防止回归。
 */
import { describe, expect, it } from 'vitest'

import { buildSceneHtml } from './render-backend'
import type { SceneStep, StoryboardSection } from './teaching-core'

const section: StoryboardSection = {
  id: 'section_1',
  title: '复习：数轴上"走几趟、每趟几步"',
  lectureLines: ['数轴：每 1 格算 1 步', '3×2：每趟向右 2 格', '走 3 趟：0→2→4→6', '乘法就是重复地走'],
  animations: ['铺轴', '第一趟', '第二三趟', '公式'],
  targetSeconds: 30,
}

/** 真机产出的原始 scene（原样抄自日志，未改一个坐标） */
const realScene: SceneStep[] = [
  {
    elements: [
      {
        kind: 'axis',
        color: '#e5e7eb',
        x: 3,
        y: 62,
        w: 94,
        h: 14,
        axis: { from: -6, to: 6, marks: [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6] },
      },
    ],
  },
  {
    elements: [
      { kind: 'arrow', color: '#60a5fa', from: { x: 50, y: 56 }, x: 65.7, y: 56 },
      { kind: 'text', content: '+2', color: '#93c5fd', x: 55, y: 47, w: 6, h: 8 },
    ],
  },
  {
    elements: [
      { kind: 'arrow', color: '#60a5fa', from: { x: 65.7, y: 56 }, x: 81.3, y: 56 },
      { kind: 'arrow', color: '#60a5fa', from: { x: 81.3, y: 56 }, x: 97, y: 56 },
      { kind: 'text', content: '2 4 6', color: '#86efac', x: 60, y: 38, w: 30, h: 7 },
    ],
  },
  {
    elements: [
      { kind: 'tex', tex: '3 \\times 2 = 6', color: '#fde68a', x: 32, y: 20, w: 36, h: 10 },
      { kind: 'highlight', x: 48, y: 55.5, w: 50, h: 3 },
    ],
  },
]

describe('真机产物渲染回归', () => {
  const html = buildSceneHtml(section, realScene)

  it('数轴按像素尺寸绘制，不是 100×100 的百分比视图', () => {
    const m = /<svg class="axis-svg" width="(\d+)" height="(\d+)"/.exec(html)
    expect(m).not.toBeNull()
    // w=94% × (1280×0.7) ≈ 842
    expect(Number(m![1])).toBeGreaterThan(700)
    expect(Number(m![2])).toBeGreaterThan(50)
  })

  // 这条是根因回归：非等比拉伸会把文字压扁、刻度压到轴线上
  it('没有任何 preserveAspectRatio="none"', () => {
    expect(html).not.toContain('preserveAspectRatio="none"')
  })

  it('13 个刻度数字全部渲染，且都在轴线下方', () => {
    const ticks = html.match(/<text x="[\d.]+" y="(\d+)" text-anchor="middle"/g) ?? []
    expect(ticks).toHaveLength(13)

    const axisY = /<line x1="2" y1="(\d+)" x2="\d+" y2="\d+"/.exec(html)
    expect(axisY).not.toBeNull()
    const axisYNum = Number(axisY![1])
    for (const t of ticks) {
      const y = Number(/y="(\d+)"/.exec(t)![1])
      // 数字必须在轴**下方**且留出间距（不压在线上）
      expect(y).toBeGreaterThan(axisYNum + 5)
    }
  })

  it('箭头两端在同一水平线上（水平箭头不能被拉成斜线）', () => {
    const line = /<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/.exec(html)
    expect(line).not.toBeNull()
    expect(Number(line![2])).toBeCloseTo(Number(line![4]), 0)
  })

  it('公式渲染成 MathML', () => {
    expect(html).toContain('<math xmlns')
    expect(html).not.toContain('katex-error')
  })

  it('每一步的画面都在时间轴上', () => {
    const steps = html.match(/data-step="(\d)"/g) ?? []
    expect(new Set(steps).size).toBe(4)
  })
})
