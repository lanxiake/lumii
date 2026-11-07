/**
 * 结构模板：`derive` —— 逐步推导型。
 *
 * 骨架取自 Code2Video 的单节结构与 frametell 的 `chalkboard`（「一位好老师
 * 在黑板上一行一行推出一个东西」）。核心是**每一步只有一个变化**，前面的步
 * 留在画面上不清空，观众能回头看这一步是从哪来的。
 *
 * 这是推导/证明/算法推演类主题的主力模板。
 */

import type { TeachingTemplate } from '../types'

export const deriveTemplate: TeachingTemplate = {
  id: 'derive',
  name: '逐步推导',
  summary: '从一个已知出发，一步一个变化推到结论；前面的步不清空',
  whenToUse:
    '用户要「推导/证明/一步步算出来」：公式变形、定理证明、算法推演、求解过程。' +
    '关键是每一步只改一处，且前面改过的内容留在画面上可回看。',
  keywords: ['推导', '证明', '怎么算', '一步步', '求解', '变形', '化简', '演算', '得出'],
  styles: ['3b1b', 'chalkboard', 'math'],
  sections: [
    {
      role: 'establish',
      titleHint: '起点：已知什么',
      lectureHints: ['已知 {条件}', '要证明的是', '离目标差几步'],
      sceneHint: '把已知条件写成 tex 摆在画面上方，目标写在下方并留出距离',
      kinds: ['tex', 'highlight'],
    },
    {
      role: 'change',
      titleHint: '第一步：只改一处',
      lectureHints: ['先动 {这一项}', '其余不动', '得到 {中间式}'],
      sceneHint: '新的一行出现在上一行下方，用 highlight 框出**这一步改动的部分**',
      kinds: ['tex', 'highlight', 'arrow'],
    },
    {
      role: 'change',
      titleHint: '继续推：{关键步骤}',
      lectureHints: ['这一步是关键', '为什么能这么换', '得到 {中间式}'],
      sceneHint: '继续向下累积，每步只高亮当步改动，前面的行保持可见',
      kinds: ['tex', 'highlight', 'brace'],
    },
    {
      role: 'prove',
      titleHint: '验算：代回去看看',
      lectureHints: ['把结果代回去', '两边相等吗', '没有引入额外假设'],
      sceneHint: '用 table 并排原式与检验结果，或用 tex 展示「左边 = 右边」',
      kinds: ['tex', 'table'],
    },
    {
      role: 'hold',
      titleHint: '落点：{结论}',
      lectureHints: ['所以 {结论}', '整个过程只用了', '这一步是最容易错的'],
      sceneHint: '结论用 tex 加框，把整条推导用 brace 括起来并标注总步骤数',
      kinds: ['tex', 'brace', 'highlight'],
    },
  ],
  roles: [
    { id: 'line1', kind: 'tex', purpose: '推导的第 1 行（起点）' },
    { id: 'line2', kind: 'tex', purpose: '推导的第 2 行（这一步改了什么）' },
    { id: 'line3', kind: 'tex', purpose: '推导的第 3 行（关键步骤）' },
    { id: 'result', kind: 'tex', purpose: '最后落到的结论' },
    { id: 'mark', kind: 'highlight', purpose: '这一步改动的部分' },
  ],
  example: {
    title: '推导一元二次方程的求根公式',
    lectureLines: ['从 ax²+bx+c=0 出发', '先除以 a', '配方：凑成完全平方', '开方', '移项得到求根公式'],
    scene: [
      {
        elements: [{ kind: 'tex', tex: 'ax^2 + bx + c = 0', x: 25, y: 20, w: 50, h: 12 }],
      },
      {
        elements: [
          { kind: 'tex', tex: 'ax^2 + bx + c = 0', x: 25, y: 20, w: 50, h: 12 },
          { kind: 'tex', tex: 'x^2 + \\frac{b}{a}x + \\frac{c}{a} = 0', x: 20, y: 38, w: 60, h: 12 },
          { kind: 'highlight', x: 18, y: 35, w: 64, h: 18, color: '#fde68a' },
        ],
      },
      {
        elements: [
          {
            kind: 'tex',
            tex: '\\left(x + \\frac{b}{2a}\\right)^2 = \\frac{b^2 - 4ac}{4a^2}',
            x: 12,
            y: 38,
            w: 76,
            h: 14,
          },
          { kind: 'highlight', x: 10, y: 35, w: 80, h: 20, color: '#86efac' },
        ],
      },
      {
        elements: [
          {
            kind: 'tex',
            tex: 'x + \\frac{b}{2a} = \\pm\\frac{\\sqrt{b^2-4ac}}{2a}',
            x: 12,
            y: 55,
            w: 76,
            h: 14,
          },
        ],
      },
      {
        elements: [
          {
            kind: 'tex',
            tex: 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}',
            x: 18,
            y: 40,
            w: 64,
            h: 16,
          },
          { kind: 'highlight', x: 15, y: 36, w: 70, h: 24, color: '#93c5fd' },
        ],
      },
    ],
  },
}
