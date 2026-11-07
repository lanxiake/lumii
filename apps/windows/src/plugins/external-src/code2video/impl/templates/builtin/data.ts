/**
 * 结构模板：`data` —— 数据解读型。
 *
 * 骨架取自 frametell 的 `isotype`（象形统计）与 HyperFrames 的 `data-chart`：
 * 抛出问题 → 展示数据 → 读出对比 → 给出结论。
 *
 * 与 `pattern` 的区别：pattern 是「从数据里找规律」，data 是「用数据支持一个结论」。
 */

import type { TeachingTemplate } from '../types'

export const dataTemplate: TeachingTemplate = {
  id: 'data',
  name: '数据解读',
  summary: '抛问题 → 展数据 → 读出对比 → 下结论',
  whenToUse:
    '用户给了一份数据/报表/调查结果，要讲出它说明了什么。' +
    '每个数字都必须来自用户给的数据，不能推测或补充。',
  keywords: ['数据', '报表', '统计', '占比', '增长', '调查', '指标', '排名', '多少'],
  styles: ['isotype', 'clean', 'tech-dark'],
  sections: [
    {
      role: 'establish',
      titleHint: '先问一个问题',
      lectureHints: ['{指标} 到底多少', '直觉上是', '实际是'],
      sceneHint: '问题以一行大字出现，暂时不给数字',
      kinds: ['text', 'tex'],
    },
    {
      role: 'change',
      titleHint: '数据摆出来',
      lectureHints: ['真实数据是', '分成 {n} 类', '最大的是 {值}'],
      sceneHint: 'table 或 curve 展示完整数据，不要只给结论',
      kinds: ['table', 'curve'],
    },
    {
      role: 'change',
      titleHint: '对比：和谁比',
      lectureHints: ['和 {基准} 比', '差 {倍数}', '这个差距意味着'],
      sceneHint: '并排对比或高亮关键行，差异必须视觉可辨',
      kinds: ['table', 'highlight', 'brace'],
    },
    {
      role: 'hold',
      titleHint: '结论：所以该怎么做',
      lectureHints: ['数据说明 {结论}', '据此可以', '但要注意 {局限}'],
      sceneHint: '结论一句话，加 highlight；局限用小字标出',
      kinds: ['text', 'tex', 'highlight'],
    },
  ],
  roles: [
    { id: 'table', kind: 'table', purpose: '数据表' },
    { id: 'insight', kind: 'text', purpose: '从数据读出的结论' },
  ],
  example: {
    title: '手机电量掉得快，到底是谁在吃电',
    lectureLines: ['一天掉 80% 的电', '屏幕占一半', '后台应用占三成', '其余是系统'],
    scene: [
      {
        elements: [{ kind: 'text', content: '一天掉 80% 的电，都去哪了？', x: 8, y: 40, w: 84, h: 10 }],
      },
      {
        elements: [
          {
            kind: 'table',
            x: 20,
            y: 25,
            w: 60,
            h: 44,
            table: { headers: ['来源', '占比'], rows: [['屏幕', '48%'], ['后台应用', '31%'], ['系统', '21%']] },
          },
        ],
      },
      {
        elements: [
          {
            kind: 'table',
            x: 20,
            y: 25,
            w: 60,
            h: 44,
            table: { headers: ['来源', '占比'], rows: [['屏幕', '48%'], ['后台应用', '31%'], ['系统', '21%']], highlightRow: 0 },
          },
          { kind: 'brace', from: { x: 84, y: 25 }, to: { x: 84, y: 38 }, color: '#fde68a' },
        ],
      },
      {
        elements: [
          { kind: 'text', content: '先缩短亮屏时间', x: 20, y: 70, w: 60, h: 9, color: '#86efac' },
          { kind: 'highlight', x: 16, y: 66, w: 68, h: 16, color: '#86efac' },
        ],
      },
    ],
  },
}
