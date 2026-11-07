/**
 * 结构模板：`pattern` —— 找规律型。
 *
 * 骨架取自 Code2Video 117 题里的主力结构（数列、归纳、统计）：
 * 先摆出几个真实数据，排成表让规律**自己显形**，再命名它，最后验证。
 *
 * 关键约束：数据必须真的算对。这一节最容易出现的错是「表格里的数字是编的」，
 * 所以每一步只让一行亮起，且高亮列要指向「从哪一列看出规律」。
 */

import type { TeachingTemplate } from '../types'

export const patternTemplate: TeachingTemplate = {
  id: 'pattern',
  name: '找规律',
  summary: '摆出几组真实数据 → 排成表 → 规律自己显形 → 命名 → 验证',
  whenToUse:
    '用户要给一组数据、数列、统计结果，或要从若干例子看出规律（归纳）。' +
    '表格里的每个数字都必须真的算对，不能编。',
  keywords: ['规律', '归纳', '数列', '统计', '趋势', '数据', '表格', '模式', '频次'],
  styles: ['clean', 'chalkboard', 'isotype'],
  sections: [
    {
      role: 'establish',
      titleHint: '先看这几组数据',
      lectureHints: ['拿到 {n} 组数据', '它们看起来不一致', '先排成表'],
      sceneHint: '空表格出现，表头只有列名——数据还没填',
      kinds: ['table'],
    },
    {
      role: 'change',
      titleHint: '逐行填进去',
      lectureHints: ['第一行是 {值}', '第二行', '每填一行就看一眼'],
      sceneHint: '逐行点亮（highlightRow），每步只填一行，让观众跟着读',
      kinds: ['table', 'highlight'],
    },
    {
      role: 'name',
      titleHint: '规律：{规律}',
      lectureHints: ['看这一列', '每行都在 {变化}', '所以规律是 {规律}'],
      sceneHint: '用 brace 括住看规律的那一列，规律用 tex 写出来',
      kinds: ['brace', 'tex', 'highlight'],
    },
    {
      role: 'prove',
      titleHint: '验一下：下一项是多少',
      lectureHints: ['按规律推下一项', '是 {预测值}', '和实际对不对'],
      sceneHint: '把预测值与实际值并排，一致就绿色高亮，不一致就红',
      kinds: ['tex', 'highlight', 'table'],
    },
    {
      role: 'hold',
      titleHint: '收束：这条规律能用到哪',
      lectureHints: ['所以 {规律}', '它能推出 {结论}', '但也只在这类情况下成立'],
      sceneHint: '规律与结论并排，用 brace 括住「前提 → 结果」的对应关系',
      kinds: ['brace', 'tex', 'highlight'],
    },
  ],
  roles: [
    { id: 'table', kind: 'table', purpose: '逐行填数据的表格' },
    { id: 'rule', kind: 'tex', purpose: '从数据里看出来的规律' },
  ],
  example: {
    title: '从 (-3)×3 推到 (-3)×(-1) 找规律',
    lectureLines: ['(-3)×3 = -9', '乘数每减 1，结果加 3', '推到乘数 0 得 0', '再减 1 得 +3', '所以 (-3)×(-1)=+3'],
    scene: [
      {
        elements: [
          {
            kind: 'table',
            x: 12,
            y: 20,
            w: 76,
            h: 50,
            table: { headers: ['乘数', '结果'], rows: [['3', '-9']] },
          },
        ],
      },
      {
        elements: [
          {
            kind: 'table',
            x: 12,
            y: 20,
            w: 76,
            h: 50,
            table: { headers: ['乘数', '结果'], rows: [['3', '-9'], ['2', '-6']], highlightRow: 1 },
          },
        ],
      },
      {
        elements: [
          {
            kind: 'table',
            x: 12,
            y: 20,
            w: 76,
            h: 50,
            table: { headers: ['乘数', '结果'], rows: [['3', '-9'], ['2', '-6'], ['1', '-3'], ['0', '0']], highlightRow: 3 },
          },
        ],
      },
      {
        elements: [
          {
            kind: 'table',
            x: 12,
            y: 18,
            w: 76,
            h: 56,
            table: {
              headers: ['乘数', '结果'],
              rows: [['3', '-9'], ['2', '-6'], ['1', '-3'], ['0', '0'], ['-1', '+3']],
              highlightRow: 4,
            },
          },
          { kind: 'tex', tex: '\\Delta = +3', x: 78, y: 40, w: 20, h: 10 },
        ],
      },
    ],
  },
}
