/**
 * 结构模板：`cause` —— 因果链型。
 *
 * 骨架取自 nn 的机制解释与 SenseNova 的 explainer 指南「先建立对象 → 展示变化 →
 * 才命名」。适合「A 导致 B，B 导致 C」这类连锁反应的机制解释。
 *
 * 与 `process` 的区别：process 是人为设计的步骤（顺序可任意重排），cause 是
 * 自然发生的因果（顺序由物理/逻辑决定，不能乱）。
 */

import type { TeachingTemplate } from '../types'

export const causeTemplate: TeachingTemplate = {
  id: 'cause',
  name: '因果链',
  summary: '一个原因 → 连锁反应 → 结果；每环都要能问「为什么」',
  whenToUse:
    '主题是「为什么会这样」的机制连锁：物理现象、经济传导、故障扩散、政策影响。' +
    '每两环之间必须能回答「为什么这个导致那个」。',
  keywords: ['导致', '引起', '因为', '所以', '连锁', '传导', '机制', '为什么这样', '效应'],
  styles: ['3b1b', 'clean', 'instrument'],
  sections: [
    {
      role: 'establish',
      titleHint: '起点：一个条件',
      lectureHints: ['当 {条件} 出现', '它先影响的是', '注意这不是原因'],
      sceneHint: '只放一个变量，其他全空——先把起点摆干净',
      kinds: ['tex', 'text'],
    },
    {
      role: 'change',
      titleHint: '第一环：因为 {机制 1}',
      lectureHints: ['它导致 {结果 1}', '原因是 {机制}', '这一步没有别的解释'],
      sceneHint: 'arrow 指向第二个状态，机制写在箭头上',
      kinds: ['arrow', 'tex', 'highlight'],
    },
    {
      role: 'change',
      titleHint: '第二环：接着引发 {结果 2}',
      lectureHints: ['{结果 1} 又导致', '这里开始失控', '幅度越来越小/大'],
      sceneHint: '第二个 arrow，链式排列，每一步状态可见',
      kinds: ['arrow', 'curve', 'highlight'],
    },
    {
      role: 'prove',
      titleHint: '验证：反过来成立吗',
      lectureHints: ['去掉 {条件} 会怎样', '链条就断了', '所以起点是必要的'],
      sceneHint: '把链条的第一环拿掉，后面的全部变灰',
      kinds: ['arrow', 'highlight', 'table'],
    },
    {
      role: 'hold',
      titleHint: '收束：整条链的必然性',
      lectureHints: ['所以 {现象} 不是巧合', '只要 {条件} 在', '结果就一定会发生'],
      sceneHint: '整条链缩成一行，两端加 brace 标出「条件 → 结果」',
      kinds: ['brace', 'tex', 'arrow'],
    },
  ],
  example: {
    title: '为什么通货膨胀会让存款变少',
    lectureLines: ['央行多发了钱', '钱多了，商品没多', '物价被推高', '同样的钱买到的东西变少'],
    scene: [
      {
        elements: [{ kind: 'tex', tex: '\\text{货币供应} \\uparrow', x: 28, y: 40, w: 44, h: 12 }],
      },
      {
        elements: [
          { kind: 'tex', tex: '\\text{货币供应} \\uparrow', x: 8, y: 40, w: 36, h: 12 },
          { kind: 'arrow', from: { x: 46, y: 46 }, x: 62, y: 46, color: '#fca5a5' },
          { kind: 'tex', tex: '\\text{商品总量 不变}', x: 62, y: 40, w: 30, h: 12, color: '#fca5a5' },
        ],
      },
      {
        elements: [
          { kind: 'tex', tex: '\\text{货币供应} \\uparrow', x: 4, y: 40, w: 28, h: 12 },
          { kind: 'arrow', from: { x: 33, y: 46 }, x: 44, y: 46, color: '#fca5a5' },
          { kind: 'tex', tex: '\\text{商品总量 不变}', x: 44, y: 40, w: 26, h: 12, color: '#fca5a5' },
        ],
      },
      {
        elements: [
          { kind: 'arrow', from: { x: 71, y: 46 }, x: 80, y: 46, color: '#fde68a' },
          { kind: 'tex', tex: '\\text{物价} \\uparrow', x: 80, y: 40, w: 18, h: 12, color: '#fde68a' },
          { kind: 'arrow', from: { x: 50, y: 58 }, x: 50, y: 70, color: '#86efac' },
        ],
      },
      {
        elements: [
          { kind: 'tex', tex: '\\text{存款购买力} \\downarrow', x: 26, y: 72, w: 48, h: 12, color: '#86efac' },
          { kind: 'tex', tex: '\\text{钱多} \\Rightarrow \\text{物价涨} \\Rightarrow \\text{钱不值钱}', x: 4, y: 20, w: 92, h: 10 },
          { kind: 'brace', from: { x: 2, y: 30 }, to: { x: 2, y: 50 }, color: '#fde68a' },
        ],
      },
    ],
  },
}
