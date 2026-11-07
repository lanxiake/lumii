/**
 * 结构模板：`story` —— 案例/叙事型。
 *
 * 骨架取自 frametell 的 `manga` / `warm-story`：角色 → 困境 → 转折 → 结果。
 * 适合真实案例、个人经历、心理成长、职场故事。
 *
 * 与 `explain` 的区别：explain 讲的是**概念**，story 讲的是**一个人发生了什么**。
 * 关键约束：不要用真实姓名或可识别信息，除非用户自己提供。
 */

import type { TeachingTemplate } from '../types'

export const storyTemplate: TeachingTemplate = {
  id: 'story',
  name: '案例/叙事',
  summary: '角色 → 困境 → 转折 → 结果 → 启示',
  whenToUse:
    '用户要讲一个具体案例、某人的经历、一次复盘，或通过故事说明一个道理。' +
    '和「通用解释」的区别是：讲的是一个人/组织发生了什么，而不是一个概念。',
  keywords: ['案例', '故事', '经历', '复盘', '教训', '后来', '当年', '一个人', '某公司'],
  styles: ['warm-story', 'manga', 'papercut'],
  sections: [
    {
      role: 'establish',
      titleHint: '开场：{角色} 遇到什么',
      lectureHints: ['{角色} 当时在', '手上只有 [资源]', '想要 [目标]'],
      sceneHint: '用一个具体对象代表角色（不画人脸），摆出初始处境',
      kinds: ['text', 'rect', 'circle'],
    },
    {
      role: 'change',
      titleHint: '困境：卡在哪',
      lectureHints: ['问题出在 {卡点}', '试过 {方法} 没用', '压力越来越大'],
      sceneHint: '用 highlight 标出卡点，其他元素变暗',
    },
    {
      role: 'change',
      titleHint: '转折：因为 {关键动作}',
      lectureHints: ['转折是 {动作}', '它改变了 {什么}', '为什么这次不一样'],
      sceneHint: '一个明显的方向变化——arrow 反向或元素重组',
      kinds: ['arrow', 'highlight', 'tex'],
    },
    {
      role: 'prove',
      titleHint: '结果：数据说话',
      lectureHints: ['结果是 {数据}', '前后差了 {倍}', '不是运气'],
      sceneHint: '用 table 并排前后数据，或用 tex 写清倍数关系',
      kinds: ['table', 'tex', 'highlight'],
    },
    {
      role: 'hold',
      titleHint: '启示：如果换成你',
      lectureHints: ['这个案例说明', '你可以照做的是', '但要注意 {前提}'],
      sceneHint: '回到开场那个对象，但状态已经不同',
      kinds: ['text', 'highlight', 'tex'],
    },
  ],
  example: {
    title: '一家小店的库存是怎么压垮现金流的',
    lectureLines: ['起初只有 20 个 SKU', '卖得好的被追单', '库存涨到 200 个 SKU', '现金全压在货上'],
    scene: [
      {
        elements: [
          { kind: 'text', content: '20 个 SKU', x: 30, y: 40, w: 40, h: 10, color: '#86efac' },
          { kind: 'rect', x: 25, y: 55, w: 50, h: 8, color: '#86efac' },
        ],
      },
      {
        elements: [
          { kind: 'text', content: '好卖的追单', x: 30, y: 22, w: 40, h: 8, color: '#93c5fd' },
          { kind: 'rect', x: 25, y: 55, w: 50, h: 18, color: '#93c5fd' },
          { kind: 'highlight', x: 22, y: 52, w: 56, h: 24, color: '#fde68a' },
        ],
      },
      {
        elements: [
          { kind: 'text', content: '200 个 SKU', x: 30, y: 18, w: 40, h: 9, color: '#fca5a5' },
          { kind: 'rect', x: 15, y: 40, w: 70, h: 34, color: '#fca5a5' },
          { kind: 'arrow', from: { x: 50, y: 36 }, x: 50, y: 30, color: '#fca5a5' },
        ],
      },
      {
        elements: [
          {
            kind: 'table',
            x: 20,
            y: 30,
            w: 60,
            h: 34,
            table: { headers: ['项目', '金额'], rows: [['库存占用', '占比 72%'], ['可动用现金', '仅够 3 周']], highlightRow: 1 },
          },
        ],
      },
      {
        elements: [
          { kind: 'text', content: 'SKU 越多，现金越薄', x: 12, y: 70, w: 76, h: 10, color: '#93c5fd' },
          { kind: 'brace', from: { x: 8, y: 28 }, to: { x: 8, y: 66 }, color: '#fde68a' },
        ],
      },
    ],
  },
}
