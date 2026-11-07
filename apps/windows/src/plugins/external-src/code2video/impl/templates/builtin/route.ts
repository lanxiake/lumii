/**
 * 结构模板：`route` —— 决策/分岔型。
 *
 * 骨架取自 frametell 的 `metro` 样例（《发烧了，坐哪条线？》）：
 * 起点 → 一连串判断 → 不同判断走向不同终点。适合分诊、选型、路线规划、
 * 故障排查流程。
 *
 * 关键约束：**分岔口必须写清判据**（「满足 X 走左，否则走右」）。
 * 只画分岔不写判据，观众看完还是不会自己判断。
 */

import type { TeachingTemplate } from '../types'

export const routeTemplate: TeachingTemplate = {
  id: 'route',
  name: '决策/分岔',
  summary: '起点 → 逐层判断（写清判据）→ 不同的终点',
  whenToUse:
    '用户要讲「什么情况下选哪个」：分诊就医、技术选型、排查顺序、路线规划、方案取舍。' +
    '每个分岔口必须写清判据，只画分岔不写判据等于没说。',
  keywords: ['选择', '选哪个', '什么情况', '判断', '分岔', '路线', '排查', '分诊', '决策'],
  styles: ['metro', 'clean', 'tech-dark'],
  sections: [
    {
      role: 'establish',
      titleHint: '起点：{问题}，先看一件事',
      lectureHints: ['遇到 {问题}', '先别急着选', '第一个要看的是'],
      sceneHint: '起点用一个圆点标出，第一个判断条件写在旁边',
      kinds: ['circle', 'text', 'arrow'],
    },
    {
      role: 'change',
      titleHint: '分岔 1：满足 {条件 A} 走左',
      lectureHints: ['如果 {条件 A}', '就往这边走', '它的终点是 {终点 1}'],
      sceneHint: 'draw 出一条分支线路，末端标终点',
      kinds: ['arrow', 'circle', 'text'],
    },
    {
      role: 'change',
      titleHint: '分岔 2：否则走右',
      lectureHints: ['不满足就往下', '再看 {条件 B}', '终点是 {终点 2}'],
      sceneHint: '第二条分支，颜色区分，与第一条不交叉',
      kinds: ['arrow', 'circle', 'text'],
    },
    {
      role: 'prove',
      titleHint: '最容易判断错的那个',
      lectureHints: ['{边界情况} 要当心', '它看起来像左边', '其实是右边'],
      sceneHint: '用一个 highlight 圈出易错点，画一条虚线指向正确分支',
      kinds: ['highlight', 'arrow', 'text'],
    },
    {
      role: 'hold',
      titleHint: '收束：一句话记住判断顺序',
      lectureHints: ['先看 {条件 A}', '再看 {条件 B}', '顺序不能反'],
      sceneHint: '把判断顺序压成一行箭头链，用 brace 括起来',
      kinds: ['arrow', 'brace', 'text'],
    },
  ],
  roles: [
    { id: 'start', kind: 'circle', purpose: '判断的起点' },
    { id: 'branchA', kind: 'arrow', purpose: '满足条件走这条' },
    { id: 'branchB', kind: 'arrow', purpose: '不满足走这条' },
    { id: 'label', kind: 'text', purpose: '判据文字' },
  ],
  example: {
    title: '技术选型：该用队列还是直接调用',
    lectureLines: ['先看要不要立即拿到结果', '要结果 → 直接调用', '不要 → 考虑队列', '再看失败能不能重试'],
    scene: [
      {
        elements: [
          { kind: 'circle', x: 42, y: 12, w: 14, h: 10, color: '#93c5fd' },
          { kind: 'text', content: '需要马上知道结果？', x: 30, y: 26, w: 40, h: 8 },
        ],
      },
      {
        elements: [
          { kind: 'circle', x: 42, y: 12, w: 14, h: 10, color: '#93c5fd' },
          {
            kind: 'arrow',
            from: { x: 40, y: 22 },
            x: 20,
            y: 50,
            color: '#86efac',
          },
          { kind: 'text', content: '是 → 直接调用', x: 6, y: 54, w: 28, h: 8, color: '#86efac' },
        ],
      },
      {
        elements: [
          { kind: 'circle', x: 42, y: 12, w: 14, h: 10, color: '#93c5fd' },
          {
            kind: 'arrow',
            from: { x: 58, y: 22 },
            x: 78,
            y: 50,
            color: '#fde68a',
          },
          { kind: 'text', content: '否 → 队列', x: 66, y: 54, w: 26, h: 8, color: '#fde68a' },
        ],
      },
      {
        elements: [
          { kind: 'text', content: '失败要能重试？', x: 30, y: 66, w: 40, h: 8 },
          { kind: 'arrow', from: { x: 70, y: 66 }, x: 88, y: 80, color: '#fca5a5' },
          { kind: 'highlight', x: 24, y: 62, w: 54, h: 16, color: '#fde68a' },
        ],
      },
      {
        elements: [
          { kind: 'text', content: '立即结果 → 直调；可延迟 → 队列', x: 4, y: 40, w: 92, h: 10, color: '#93c5fd' },
          { kind: 'brace', from: { x: 2, y: 34 }, to: { x: 2, y: 56 }, color: '#fde68a' },
        ],
      },
    ],
  },
}
