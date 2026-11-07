/**
 * 结构模板：`explain` —— 通用解释型。
 *
 * 骨架取自 frametell 的导演提示词（钩子 → 直觉 → 机制 → 例子 → 收束），那是
 * 「向普通人讲清一件事」最稳的五段式：先给一个具体的问题或反直觉事实，用**一个**
 * 贯穿全片的比喻建立直觉，再讲为什么成立，给一个能算的具体例子，最后回到开头
 * 但答案已经不同。
 *
 * 这是**最常用的模板**，也是匹配不到别的模板时的兜底。
 */

import type { TeachingTemplate } from '../types'

export const explainTemplate: TeachingTemplate = {
  id: 'explain',
  name: '通用解释',
  summary: '向没有背景的观众讲清一个概念：钩子 → 直觉 → 机制 → 例子 → 收束',
  whenToUse:
    '用户要「讲清楚某个概念/原理」，但没有明显的对比、推导、流程或分岔结构时用这个。' +
    '它是最通用的骨架：先抛问题，用一个比喻建立直觉，再讲机制，给一个具体例子，最后回到问题。',
  keywords: ['是什么', '为什么', '原理', '本质', '怎么理解', '通俗', '入门', '介绍', '科普'],
  styles: ['3b1b', 'chalkboard', 'clean'],
  sections: [
    {
      role: 'establish',
      titleHint: '开场：{topic} 到底是什么问题',
      lectureHints: ['先看一个具体的问题', '为什么它不直观', '这个问题值不值得搞明白'],
      sceneHint: '让问题本身以具体形态出现在画面上（一个数、一张图、一个场景），不要用标题卡开场',
      kinds: ['tex', 'text'],
    },
    {
      role: 'establish',
      titleHint: '直觉：用一个比喻先站住脚',
      lectureHints: ['把它想成 {比喻物}', '这个比喻里对应什么', '哪里还不准确'],
      sceneHint: '一个贯穿全片的比喻物，后续每一节都要回到它',
      kinds: ['text', 'curve', 'arrow'],
    },
    {
      role: 'change',
      titleHint: '机制：为什么会这样',
      lectureHints: ['真正起作用的是 {机制}', '换个角度看', '这一步是关键'],
      sceneHint: '展示机制本身——用 curve/axis 画关系，或用 arrow 画因果链',
      kinds: ['curve', 'axis', 'arrow', 'tex'],
    },
    {
      role: 'prove',
      titleHint: '例子：算一遍给你看',
      lectureHints: ['拿一个具体数字', '一步步算', '结果和直觉对上没有'],
      sceneHint: '可验证的具体例子：真实数字进 tex/table，每一步都有可见变化',
      kinds: ['tex', 'table', 'highlight'],
    },
    {
      role: 'hold',
      titleHint: '收束：回到开头的问题',
      lectureHints: ['所以 {topic}', '一句话说清', '这个比喻到此为止还成立'],
      sceneHint: '回到开场那个画面，但答案已经不同——用 highlight 框住结论',
      kinds: ['tex', 'highlight', 'text'],
    },
  ],
  roles: [
    { id: 'key', kind: 'tex', purpose: '这一节要讲的那个式子或结论，全程留在画面上' },
    { id: 'focus', kind: 'highlight', purpose: '当前这一步在讲的部分，用来把注意力引过去' },
    { id: 'note', kind: 'text', purpose: '补充说明的一句话' },
  ],
  example: {
    title: '为什么 0.999… 等于 1',
    lectureLines: ['0.999… 一直在接近 1', '但它和 1 之间没有数', '设差为 d', 'd 比任何正数都小', '所以 d 只能等于 0'],
    scene: [
      {
        elements: [
          { kind: 'tex', tex: '0.999\\ldots = ?', x: 28, y: 30, w: 44, h: 14 },
        ],
      },
      {
        elements: [
          {
            kind: 'axis',
            x: 5,
            y: 52,
            w: 90,
            h: 16,
            axis: { from: 0.9, to: 1.0, marks: [0.9, 0.99, 1] },
          },
        ],
      },
      {
        elements: [
          { kind: 'tex', tex: 'd = 1 - 0.999\\ldots', x: 20, y: 22, w: 60, h: 12 },
          { kind: 'brace', from: { x: 92, y: 52 }, to: { x: 92, y: 70 }, color: '#fde68a' },
        ],
      },
      {
        elements: [
          { kind: 'tex', tex: 'd < 0.1,\\ d < 0.01,\\ d < 0.001\\ldots', x: 8, y: 75, w: 84, h: 10 },
        ],
      },
      {
        elements: [
          { kind: 'tex', tex: 'd = 0 \\Rightarrow 0.999\\ldots = 1', x: 15, y: 30, w: 70, h: 14 },
          { kind: 'highlight', x: 12, y: 26, w: 76, h: 20, color: '#86efac' },
        ],
      },
    ],
  },
}
