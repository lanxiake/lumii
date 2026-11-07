/**
 * 结构模板：`structure` —— 结构拆解型。
 *
 * 骨架取自 explainroo 的 `hub` 版式（一主多从）与 frametell 的 `exploded`
 * （3D 拆解）：先看整体，再拆成部件，讲部件之间的关系，最后拼回整体。
 *
 * 适合「由哪些部分组成」「层次是什么」「怎么分类」。
 */

import type { TeachingTemplate } from '../types'

export const structureTemplate: TeachingTemplate = {
  id: 'structure',
  name: '结构拆解',
  summary: '整体 → 拆成部件 → 部件之间怎么配合 → 拼回整体',
  whenToUse:
    '用户要讲「一个东西由什么组成」「分几层」「怎么分类」：系统架构、组织分工、产品模块、生物结构、概念分类。',
  keywords: ['组成', '结构', '包括', '分为', '部件', '层次', '架构', '模块', '分类'],
  styles: ['clean', 'tech-dark', 'instrument'],
  sections: [
    {
      role: 'establish',
      titleHint: '先看整体',
      lectureHints: ['{整体} 是什么', '它解决 [问题]', '先不要看内部'],
      sceneHint: '只画一个整体的容器/框，内部留空',
      kinds: ['rect', 'text'],
    },
    {
      role: 'change',
      titleHint: '拆开：里面有几块',
      lectureHints: ['拆开看有 {n} 块', '每一块负责', '块与块的边界在哪'],
      sceneHint: '整体拆成若干并排的 rect，各自带标题',
      kinds: ['rect', 'text', 'brace'],
    },
    {
      role: 'change',
      titleHint: '它们之间怎么配合',
      lectureHints: ['{A} 把 {信息} 交给 {B}', '方向是单向的', '这一环最容易卡住'],
      sceneHint: '用 arrow 连起部件，标明数据/控制流向',
      kinds: ['arrow', 'text', 'highlight'],
    },
    {
      role: 'hold',
      titleHint: '拼回去：整体的价值',
      lectureHints: ['合起来才成立', '少一块会怎样', '所以 {整体} 的本质是'],
      sceneHint: '部件重新收拢成整体，用 brace 括住并标注结论',
      kinds: ['brace', 'tex', 'highlight'],
    },
  ],
  roles: [
    { id: 'part1', kind: 'rect', purpose: '第 1 个部件' },
    { id: 'part2', kind: 'rect', purpose: '第 2 个部件' },
    { id: 'part3', kind: 'rect', purpose: '第 3 个部件' },
    { id: 'link', kind: 'arrow', purpose: '部件之间的流向' },
  ],
  example: {
    title: '浏览器请求一个网页，经过哪些部分',
    lectureLines: ['浏览器先查本地缓存', '没有就问 DNS 拿 IP', '再建立 TCP 连接', '请求发出去了', '这四块各管一段'],
    scene: [
      {
        elements: [{ kind: 'rect', x: 25, y: 25, w: 50, h: 30, color: '#93c5fd' }],
      },
      {
        elements: [
          { kind: 'rect', x: 6, y: 30, w: 20, h: 20, color: '#93c5fd' },
          { kind: 'rect', x: 30, y: 30, w: 20, h: 20, color: '#86efac' },
          { kind: 'rect', x: 54, y: 30, w: 20, h: 20, color: '#fde68a' },
        ],
      },
      {
        elements: [
          { kind: 'rect', x: 78, y: 30, w: 18, h: 20, color: '#fca5a5' },
          { kind: 'arrow', from: { x: 74, y: 40 }, x: 78, y: 40, color: '#fde68a' },
        ],
      },
      {
        elements: [
          { kind: 'rect', x: 6, y: 30, w: 90, h: 20, color: '#93c5fd' },
          { kind: 'brace', from: { x: 3, y: 28 }, to: { x: 3, y: 54 }, color: '#fde68a' },
          { kind: 'text', content: '缺一环，页面就打不开', x: 20, y: 60, w: 60, h: 8 },
        ],
      },
    ],
  },
}
