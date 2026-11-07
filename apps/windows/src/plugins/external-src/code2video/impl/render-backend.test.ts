/**
 * 渲染层的结构测试。
 *
 * 这些断言只看生成的 HTML 里**有没有正确的结构**，不看画面好不好看——
 * 后者要靠抽帧目视（见门禁 C）。这里守的是「元素类型有没有被渲染成对应的
 * 标记」：数轴是 `<svg class="axis-svg">` 而不是一个空心 rect，公式是
 * `<math>` 而不是一段斜体文本。
 */
import { describe, expect, it } from 'vitest'

import { buildSceneHtml } from './render-backend'
import type { SceneStep, StoryboardSection } from './teaching-core'

const section: StoryboardSection = {
  id: 'section_1',
  title: '乘以负数：方向反转',
  lectureLines: ['对比 3×2 与 3×(-2)', '负数乘数方向反转', '结果是 -6'],
  animations: ['画轴', '翻转', '标点'],
}

function html(steps: SceneStep[]): string {
  return buildSceneHtml(section, steps)
}

describe('buildSceneHtml 元素渲染', () => {
  it('axis 渲染成 SVG 数轴并带刻度值', () => {
    const out = html([
      {
        elements: [
          {
            kind: 'axis',
            x: 5,
            y: 40,
            w: 90,
            h: 14,
            axis: { from: -6, to: 6, marks: [0, 3, -3, -6] },
          },
        ],
      },
    ])
    expect(out).toContain('<svg class="axis-svg"')
    expect(out).toContain('>-6<')
    expect(out).toContain('>-3<')
  })

  // 回归：第 2 节把 w:80 h:8 的 rect 当数轴，渲染成空心长条
  it('axis 不再退回空心 rect', () => {
    const out = html([
      { elements: [{ kind: 'axis', x: 5, y: 40, w: 90, h: 14, axis: { from: 0, to: 6 } }] },
    ])
    expect(out).not.toContain('class="el el-rect"')
  })

  it('tex 渲染成 MathML', () => {
    const out = html([
      { elements: [{ kind: 'tex', x: 30, y: 15, w: 40, h: 12, tex: '(-3)\\times(-2)=6' }] },
    ])
    expect(out).toContain('<math xmlns')
    // KaTeX 会在 annotation 里保留原始 LaTeX，说明真的被解析了而不是原样吐出
    expect(out).toContain('annotation encoding')
  })

  it('tex 无效时不抛异常，退回可读文本', () => {
    const out = html([{ elements: [{ kind: 'tex', x: 30, y: 15, w: 40, h: 12, tex: '\\frac{1' }] }])
    // 要么 KaTeX 容错渲染出来，要么退回 tex-fallback；两者都算「没有崩」
    expect(out).toMatch(/<math xmlns|tex-fallback/)
  })

  // 教学视频真正的公式要有分式/根式/求和/矩阵。KaTeX 解析失败时会吐一个
  // katex-error 的红色 span（而不是抛异常），所以必须显式断言「没有解析错误」。
  it.each([
    ['分式', '\\frac{1}{2}', 'mfrac'],
    ['根式', '\\sqrt{-1}=i', 'msqrt'],
    // 行内模式下下限/上限用 msubsup（munderover 只在 display 模式下出现）
    ['下标求和', '\\sum_{n=1}^{\\infty}\\frac{1}{n^2}', 'mfrac'],
    ['积分', '\\int_0^1 x^2\\,dx=\\frac{1}{3}', 'msubsup'],
    ['矩阵', '\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}', 'mtable'],
  ])('tex 能排出版式完整的%s', (_name, tex, expectedTag) => {
    const out = html([{ elements: [{ kind: 'tex', x: 30, y: 15, w: 40, h: 12, tex }] }])
    expect(out).not.toContain('katex-error')
    expect(out).toContain(`<${expectedTag}`)
  })

  it('table 渲染成表格并高亮指定行', () => {
    const out = html([
      {
        elements: [
          {
            kind: 'table',
            x: 60,
            y: 60,
            w: 35,
            h: 25,
            table: { headers: ['乘数', '结果'], rows: [['3', '-9'], ['2', '-6']], highlightRow: 1 },
          },
        ],
      },
    ])
    expect(out).toContain('<table class="tbl"')
    expect(out).toContain('<tr class="hl">')
  })

  it('curve 把采样点连成 path 并按像素尺寸绘制', () => {
    const out = html([
      {
        elements: [
          {
            kind: 'curve',
            x: 10,
            y: 20,
            w: 40,
            h: 40,
            curve: {
              points: [
                { x: 0, y: 80 },
                { x: 50, y: 20 },
                { x: 100, y: 80 },
              ],
            },
          },
        ],
      },
    ])
    expect(out).toContain('class="curve-svg"')
    // 采样点 0/50/100 映射到像素：0、W/2、W，y 同理按 H 换算
    // W = 40% × (1280×0.7) ≈ 358，H = 40% × 720 = 288
    expect(out).toMatch(/<path d="M 0\.0 230\.4 L 179\.0 57\.6 L 358\.0 230\.4"/)
    // 回归：不能再用 preserveAspectRatio="none" 拉伸（会把线宽与文字压扁）
    expect(out).not.toContain('preserveAspectRatio="none"')
  })

  it('arrow 画成带箭头的线', () => {
    const out = html([
      { elements: [{ kind: 'arrow', from: { x: 20, y: 80 }, x: 60, y: 80 }] },
    ])
    expect(out).toContain('<svg class="arrow-svg"')
    expect(out).toContain('<line ')
    // 水平箭头：起止两端在同一 y 上
    const m = /<line x1="([\d.]+)" y1="([\d.]+)" x2="([\d.]+)" y2="([\d.]+)"/.exec(out)
    expect(m).not.toBeNull()
    expect(Number(m![2])).toBeCloseTo(Number(m![4]), 0)
  })

  // 回归：数轴曾用 viewBox="0 0 100 100" + preserveAspectRatio="none"，
  // 非等比拉伸让 13 个刻度数字被压成横条、贴在轴线上
  it('axis 用像素 viewBox，不非等比拉伸', () => {
    const out = html([
      {
        elements: [
          {
            kind: 'axis',
            x: 5,
            y: 40,
            w: 90,
            h: 20,
            axis: { from: -6, to: 6, marks: [-6, 0, 6] },
          },
        ],
      },
    ])
    expect(out).not.toContain('preserveAspectRatio="none"')
    // 宽高是像素值而不是 100
    const m = /<svg class="axis-svg" width="(\d+)" height="(\d+)"/.exec(out)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBeGreaterThan(500)
    expect(Number(m![2])).toBeGreaterThan(100)
    // 刻度数字在轴线下方：text 的 y 必须大于轴的 y
    const axisY = /<line x1="2" y1="(\d+)"/.exec(out)
    const textY = /<text x="[\d.]+" y="(\d+)"/.exec(out)
    expect(Number(textY![1])).toBeGreaterThan(Number(axisY![1]))
  })

  it('brace 画成花括号路径', () => {
    const out = html([
      { elements: [{ kind: 'brace', from: { x: 85, y: 20 }, to: { x: 85, y: 70 } }] },
    ])
    expect(out).toContain('<svg class="brace-svg"')
    expect(out).toContain('Q ')
  })

  it('code 渲染成按行分块的 pre，并高亮指定行', () => {
    const out = html([
      {
        elements: [
          { kind: 'code', x: 10, y: 10, w: 60, h: 40, content: 'if (x) {\n  y()\n}', code: { hl: [1] } },
        ],
      },
    ])
    expect(out).toContain('<pre class="code">')
    expect(out).toContain('<div class="cl hl">')
  })

  it('所有元素按步出现在时间轴上', () => {
    const out = html([
      { elements: [{ kind: 'rect', x: 10, y: 10, w: 20, h: 20 }] },
      { elements: [{ kind: 'circle', x: 50, y: 50, w: 20, h: 20 }] },
      { elements: [{ kind: 'line', x: 20, y: 70, w: 50, h: 8 }] },
    ])
    expect(out).toMatch(/T=\[\{ at: 0, step: 0 \},\{ at: \d+, step: 1 \},\{ at: \d+, step: 2 \}\]/)
    expect(out).toContain('window.__seek')
  })

  it('HTML 转义仍然生效（防止模型内容注入标签）', () => {
    const out = html([
      { elements: [{ kind: 'text', x: 10, y: 10, w: 50, h: 10, content: '<script>bad()</script>' }] },
    ])
    expect(out).toContain('&lt;script&gt;')
    expect(out).not.toContain('<script>bad()</script>')
  })
})
