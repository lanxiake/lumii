/**
 * 结构模板：`compare` —— 对比型。
 *
 * 骨架取自 explainroo 的 `compare` 版式与 Code2Video 的负数乘法教学：
 * 先把 A 完整建立起来，再把 B 建立在**同一个坐标**上，两边的差异才有意义。
 *
 * 关键约束：**两组必须共用同一套坐标/刻度/尺度**。不共用的话对比就退化成
 * 「两张不相干的图」，观众看不出差异在哪。
 */

import type { TeachingTemplate } from '../types'

export const compareTemplate: TeachingTemplate = {
  id: 'compare',
  name: 'A/B 对比',
  summary: '两件事放在同一套坐标上比：正 vs 负、对 vs 错、前 vs 后',
  whenToUse:
    '用户要「对比/区分两个东西」，或主题本身是对称的（正负、加减、对错、新旧、成本 vs 收益）。' +
    '两边必须共用同一套坐标与刻度，否则观众看不出差异。',
  keywords: ['对比', '区别', 'vs', '不同', '差异', '正负', '好坏', '优劣', '前后'],
  styles: ['chalkboard', 'clean', '3b1b'],
  sections: [
    {
      role: 'establish',
      titleHint: '先把 {A} 摆出来',
      lectureHints: ['先看 {A} 怎么做', '它的路径是', '落点在哪'],
      sceneHint: '只画 A，坐标与刻度先立好，后续 B 要复用同一套',
      kinds: ['axis', 'arrow', 'tex'],
    },
    {
      role: 'establish',
      titleHint: '再看 {B}，同一个坐标',
      lectureHints: ['{B} 和 {A} 差在哪', '只有一处不同', '其余完全一样'],
      sceneHint: '复用 A 的坐标与刻度，只改一处变量——差异必须**肉眼可见**',
      kinds: ['axis', 'arrow', 'highlight'],
    },
    {
      role: 'change',
      titleHint: '差异出在哪一步',
      lectureHints: ['分歧点只有这一个', '往前完全相同', '从这里开始分道'],
      sceneHint: '用一个 mark/highlight 指出分歧点，两边各画一条路径',
      kinds: ['highlight', 'arrow', 'brace'],
    },
    {
      role: 'hold',
      titleHint: '结论：{A} 与 {B} 的关系',
      lectureHints: ['所以差别就是', '一句话记住', '两边的共同点是'],
      sceneHint: '两边并排收束，结论用 tex 写清，共用的部分用 brace 括起来',
      kinds: ['tex', 'brace', 'table'],
    },
  ],
  example: {
    title: '3×(-2) 与 (-3)×(-2) 的对比',
    lectureLines: ['3×2：向右走 3 趟', '3×(-2)：步长翻向左', '(-3)×(-2)：趟数也翻', '两次翻转回到正向'],
    scene: [
      // 每个元素都有 id：轴线只在第 1 步出现一次，之后一直复用；
      // 公式和箭头是**同一个对象**在不同步改内容/改方向 —— 这是动画不是幻灯片
      {
        elements: [
          { id: 'axis', kind: 'axis', x: 5, y: 40, w: 90, h: 14, axis: { from: -6, to: 6, marks: [-6, -3, 0, 3, 6] } },
          { id: 'expr', kind: 'tex', tex: '3 \\times 2 = 6', x: 30, y: 12, w: 40, h: 10 },
        ],
      },
      {
        elements: [
          // 同一个箭头对象，从「向右」翻成「向左」
          { id: 'mover', kind: 'arrow', from: { x: 50, y: 34 }, x: 75, y: 34, color: '#86efac' },
          { id: 'expr', kind: 'tex', tex: '3 \\times 2 = 6', x: 30, y: 12, w: 40, h: 10 },
        ],
      },
      {
        elements: [
          { id: 'mover', kind: 'arrow', from: { x: 50, y: 34 }, x: 25, y: 34, color: '#fca5a5' },
          { id: 'expr', kind: 'tex', tex: '3 \\times (-2) = -6', x: 26, y: 12, w: 48, h: 10 },
        ],
      },
      {
        elements: [
          // 第二次翻转：又回到右边 —— 观众看到的是「同一个箭头翻了两下」
          { id: 'mover', kind: 'arrow', from: { x: 50, y: 34 }, x: 75, y: 34, color: '#86efac' },
          { id: 'expr', kind: 'tex', tex: '(-3) \\times (-2) = 6', x: 24, y: 12, w: 52, h: 10 },
          { id: 'mark', kind: 'text', content: '翻转两次 = 回到正向', x: 22, y: 70, w: 56, h: 10, color: '#fde68a' },
        ],
      },
    ],
  },
}
