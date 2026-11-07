/**
 * 结构模板：`timeline` —— 时间线/历史型。
 *
 * 骨架取自 frametell 的 `old-map` / `ukiyoe`：先把时间轴立起来，再往上面放
 * 事件，讲事件之间的因果，最后看影响。
 *
 * 关键约束：**每个事件的时点必须是真实的**。历史类视频最容易出的错是
 * 「时间顺序对但年代编错」，那比不标年代更糟。
 */

import type { TeachingTemplate } from '../types'

export const timelineTemplate: TeachingTemplate = {
  id: 'timeline',
  name: '时间线/历史',
  summary: '立起时间轴 → 放事件 → 讲因果 → 看影响',
  whenToUse:
    '用户要讲一段发展史、项目复盘、版本演进、事件经过。' +
    '每个事件的年代必须是真实的，拿不准就只标先后不标年份。',
  keywords: ['历史', '发展', '演变', '经过', '时间线', '历程', '演进', '复盘', '后来'],
  styles: ['old-map', 'ukiyoe', 'clean'],
  sections: [
    {
      role: 'establish',
      titleHint: '先把时间立起来',
      lectureHints: ['从 {起始} 到 {结束}', '中间发生过几件事', '先看跨度'],
      sceneHint: '画一条 axis 作为时间轴，标出起止，事件点暂不出现',
      kinds: ['axis'],
    },
    {
      role: 'change',
      titleHint: '第一件事：{事件 1}',
      lectureHints: ['{时间} 发生了 {事件}', '当时的状态是', '为什么是这时候'],
      sceneHint: '在轴上标出第一个事件点，事件说明放在轴的上下交替位置',
      kinds: ['axis', 'circle', 'text'],
    },
    {
      role: 'change',
      titleHint: '转折：{事件 2}',
      lectureHints: ['转折出现在 {事件 2}', '它改变了 {什么}', '前后差别在哪'],
      sceneHint: '第二个事件点用不同颜色，画一条竖线标出「分界」',
      kinds: ['axis', 'arrow', 'highlight'],
    },
    {
      role: 'prove',
      titleHint: '因果：为什么会这样',
      lectureHints: ['不是巧合', '{原因} 导致了它', '还有 {其他因素}'],
      sceneHint: '用 arrow 把前后事件连起来，标出因果方向',
      kinds: ['arrow', 'text', 'brace'],
    },
    {
      role: 'hold',
      titleHint: '影响：一直影响到今天',
      lectureHints: ['这件事的影响是', '直到 {现在} 还能看到', '所以 {结论}'],
      sceneHint: '把整条时间轴缩短成一段，末端用 highlight 指向「现在」',
      kinds: ['axis', 'highlight', 'tex'],
    },
  ],
  example: {
    title: 'HTTP 协议的演进',
    lectureLines: ['1991 只有 HTTP/0.9', '1996 HTTP/1.0 加了头部', '1999 HTTP/1.1 支持长连接', '2015 HTTP/2 多路复用'],
    scene: [
      {
        elements: [
          { kind: 'axis', x: 5, y: 45, w: 90, h: 14, axis: { from: 1991, to: 2015, marks: [1991, 1996, 1999, 2015] } },
        ],
      },
      {
        elements: [
          { kind: 'axis', x: 5, y: 45, w: 90, h: 14, axis: { from: 1991, to: 2015, marks: [1991, 1996] } },
          { kind: 'text', content: '只有 GET', x: 2, y: 22, w: 22, h: 7, color: '#93c5fd' },
          { kind: 'arrow', from: { x: 12, y: 38 }, x: 12, y: 30, color: '#93c5fd' },
        ],
      },
      {
        elements: [
          { kind: 'axis', x: 5, y: 45, w: 90, h: 14, axis: { from: 1991, to: 2015, marks: [1991, 1996, 1999] } },
          { kind: 'text', content: '加头部与状态码', x: 20, y: 60, w: 30, h: 7, color: '#86efac' },
          { kind: 'arrow', from: { x: 35, y: 52 }, x: 35, y: 60, color: '#86efac' },
        ],
      },
      {
        elements: [
          { kind: 'axis', x: 5, y: 45, w: 90, h: 14, axis: { from: 1991, to: 2015, marks: [1991, 1996, 1999, 2015] } },
          { kind: 'arrow', from: { x: 42, y: 22 }, x: 88, y: 22, color: '#fde68a' },
          { kind: 'text', content: '多路复用解决了队头阻塞', x: 20, y: 12, w: 60, h: 7, color: '#fde68a' },
        ],
      },
      {
        elements: [
          { kind: 'text', content: '每一版都在解决上一版的瓶颈', x: 8, y: 72, w: 84, h: 9, color: '#93c5fd' },
          { kind: 'brace', from: { x: 3, y: 42 }, to: { x: 3, y: 62 }, color: '#fde68a' },
        ],
      },
    ],
  },
}
