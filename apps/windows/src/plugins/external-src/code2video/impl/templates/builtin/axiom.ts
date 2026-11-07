/**
 * 结构模板：`axiom` —— 定义/公理型。
 *
 * 骨架取自 SenseNova 的 explainer 指南（「先动画、后公式，绝不单独出现公式」）：
 * 先给一个具体的例子让观众摸得着，再抽象成定义，再说清边界，最后回到例子。
 *
 * 适合「什么是 X」这类定义型主题——这类最容易讲成背书，这一版式专门防它。
 */

import type { TeachingTemplate } from '../types'

export const axiomTemplate: TeachingTemplate = {
  id: 'axiom',
  name: '定义/概念',
  summary: '具体例子 → 抽象成定义 → 说清边界 → 回到例子',
  whenToUse:
    '用户要讲「什么是 X」：一个新概念、一个术语的定义、一个分类的判据。' +
    '绝不能先给定义再举例——那一开始就把观众挡在门外了。',
  keywords: ['什么是', '定义', '概念', '指的是', '含义', '叫', '称为', '算不算'],
  styles: ['clean', 'chalkboard', '3b1b'],
  sections: [
    {
      role: 'establish',
      titleHint: '先看三个例子',
      lectureHints: ['这三个都是 {概念}', '它们看起来不一样', '但有个共同点'],
      sceneHint: '三个具体实例并排，先不下定义',
      kinds: ['text', 'rect', 'table'],
    },
    {
      role: 'change',
      titleHint: '共同点是什么',
      lectureHints: ['共同点是 {特征}', '满足它才算', '缺一个就不算'],
      sceneHint: '用 brace 把三个例子的共同特征括到一起',
      kinds: ['brace', 'text', 'highlight'],
    },
    {
      role: 'name',
      titleHint: '所以定义是：{定义}',
      lectureHints: ['这就是 {术语} 的定义', '注意措辞里每个词', '换掉一个就错'],
      sceneHint: '定义用 tex 写出来，关键词逐一高亮',
      kinds: ['tex', 'highlight'],
    },
    {
      role: 'prove',
      titleHint: '边界：什么不算',
      lectureHints: ['这个看起来像但不算', '差在 {判据}', '所以边界是 {边界}'],
      sceneHint: '一个反例与正例并排，用红色/绿色区分',
      kinds: ['table', 'highlight', 'text'],
    },
    {
      role: 'hold',
      titleHint: '回到开头那三个例子',
      lectureHints: ['现在再看开头三个', '都能对上定义', '所以它们是同类'],
      sceneHint: '回到开场布局，每个例子旁标注它满足的那一条',
      kinds: ['text', 'highlight', 'tex'],
    },
  ],
  roles: [
    { id: 'examples', kind: 'text', purpose: '几个具体例子' },
    { id: 'def', kind: 'tex', purpose: '抽象出来的定义' },
    { id: 'boundary', kind: 'table', purpose: '边界：什么算、什么不算' },
  ],
  example: {
    title: '什么是质数',
    lectureLines: ['2、3、5、7 都是质数', '共同点：只能被 1 和自己整除', '定义写出来', '1 不算，因为它只有一个因数'],
    scene: [
      {
        elements: [
          { kind: 'text', content: '2   3   5   7', x: 20, y: 40, w: 60, h: 12, color: '#93c5fd' },
        ],
      },
      {
        elements: [
          { kind: 'text', content: '2   3   5   7', x: 20, y: 40, w: 60, h: 12, color: '#93c5fd' },
          { kind: 'brace', from: { x: 16, y: 38 }, to: { x: 16, y: 56 }, color: '#fde68a' },
          { kind: 'text', content: '只有 1 和它自己', x: 20, y: 62, w: 60, h: 8, color: '#fde68a' },
        ],
      },
      {
        elements: [
          {
            kind: 'tex',
            tex: '\\text{质数} = \\{n > 1 : \\text{因数只有 } 1 \\text{ 和 } n\\}',
            x: 6,
            y: 40,
            w: 88,
            h: 12,
          },
          { kind: 'highlight', x: 4, y: 36, w: 92, h: 20, color: '#fde68a' },
        ],
      },
      {
        elements: [
          {
            kind: 'table',
            x: 22,
            y: 30,
            w: 56,
            h: 34,
            table: {
              headers: ['数', '是否是质数'],
              rows: [['7', '是'], ['1', '不在定义范围内']],
              highlightRow: 1,
            },
          },
        ],
      },
      {
        elements: [
          { kind: 'text', content: '2   3   5   7', x: 20, y: 30, w: 60, h: 10, color: '#93c5fd' },
          { kind: 'tex', tex: '\\text{都满足 } n > 1 \\text{ 且因数只有两个}', x: 8, y: 50, w: 84, h: 10 },
        ],
      },
    ],
  },
}
