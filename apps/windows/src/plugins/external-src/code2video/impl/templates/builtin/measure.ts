/**
 * 结构模板：`measure` —— 数轴/度量型。
 *
 * 骨架取自 explainroo 的 `number` 版式：一个量沿一条轴走一趟，观众看见的是
 * **位置变化**而不是一堆数字。适合距离、方向、区间、误差、温度、时间轴。
 *
 * 这一版式最依赖 `axis` 元素——没有它就只能拿很扁的 rect 凑，那会变成空心长框
 * （实测过）。
 */

import type { TeachingTemplate } from '../types'

export const measureTemplate: TeachingTemplate = {
  id: 'measure',
  name: '数轴/度量',
  summary: '把量放到一条轴上，看它怎么移动；适合距离、方向、区间、误差',
  whenToUse:
    '主题涉及位置、距离、方向、区间、误差、温度、时间跨度这类**有刻度**的量。' +
    '核心是让观众看见「位置怎么变」，而不是读一串数字。',
  keywords: ['数轴', '坐标', '距离', '方向', '区间', '范围', '误差', '温度', '刻度', '大小'],
  styles: ['3b1b', 'chalkboard', 'clean'],
  sections: [
    {
      role: 'establish',
      titleHint: '先立一条轴',
      lectureHints: ['从 {起点} 到 {终点}', '每一格是一个单位', '原点在哪'],
      sceneHint: '画一条完整的 axis，刻度标全，原点加粗',
      kinds: ['axis'],
    },
    {
      role: 'change',
      titleHint: '在轴上走一趟',
      lectureHints: ['从 {起点} 出发', '走了 {n} 格', '落在 {终点}'],
      sceneHint: '用 arrow 从起点指向落点，落点用 circle 或 text 标出',
      kinds: ['axis', 'arrow', 'circle'],
    },
    {
      role: 'name',
      titleHint: '把这段读成一个数',
      lectureHints: ['这段长度是 {值}', '方向决定正负', '读作 {结论}'],
      sceneHint: '用 brace 括住走过的区间并标注长度',
      kinds: ['axis', 'brace', 'tex'],
    },
    {
      role: 'hold',
      titleHint: '换个起点再走一次',
      lectureHints: ['换到 {新起点}', '同样的走法', '结果差在哪'],
      sceneHint: '同一根轴上第二次走，用不同颜色建立对比',
      kinds: ['axis', 'arrow', 'highlight'],
    },
  ],
  roles: [
    { id: 'axis', kind: 'axis', purpose: '数轴，只在第 1 步出现一次' },
    { id: 'mover', kind: 'arrow', purpose: '从起点走到落点的那一支箭头' },
    { id: 'label', kind: 'text', purpose: '当前标注的数值或方向' },
    { id: 'span', kind: 'brace', purpose: '把走过的区间括起来' },
  ],
  example: {
    title: '负数在数轴上的位置',
    lectureLines: ['原点在中间', '向右为正，向左为负', '-3 在 0 左边 3 格', '绝对值就是离 0 的距离'],
    scene: [
      {
        elements: [
          {
            kind: 'axis',
            x: 5,
            y: 40,
            w: 90,
            h: 16,
            axis: { from: -5, to: 5, marks: [-5, -3, 0, 3, 5] },
          },
        ],
      },
      {
        elements: [
          {
            kind: 'axis',
            x: 5,
            y: 40,
            w: 90,
            h: 16,
            axis: { from: -5, to: 5, marks: [-5, -3, 0, 3, 5] },
          },
          { kind: 'arrow', from: { x: 50, y: 34 }, x: 80, y: 34, color: '#86efac' },
          { kind: 'text', content: '正方向', x: 72, y: 22, w: 22, h: 8, color: '#86efac' },
        ],
      },
      {
        elements: [
          {
            kind: 'axis',
            x: 5,
            y: 40,
            w: 90,
            h: 16,
            axis: { from: -5, to: 5, marks: [-5, -3, 0, 3, 5] },
          },
          { kind: 'arrow', from: { x: 50, y: 60 }, x: 20, y: 60, color: '#fca5a5' },
          { kind: 'text', content: '-3', x: 17, y: 70, w: 8, h: 8, color: '#fca5a5' },
        ],
      },
      {
        elements: [
          {
            kind: 'axis',
            x: 5,
            y: 40,
            w: 90,
            h: 16,
            axis: { from: -5, to: 5, marks: [-5, -3, 0, 3, 5] },
          },
          { kind: 'brace', from: { x: 20, y: 40 }, to: { x: 20, y: 62 }, color: '#fde68a' },
          { kind: 'tex', tex: '|-3| = 3', x: 6, y: 70, w: 26, h: 10 },
        ],
      },
    ],
  },
}
