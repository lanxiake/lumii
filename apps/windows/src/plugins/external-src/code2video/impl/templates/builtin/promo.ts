/**
 * 结构模板：`promo` —— 产品/卖点型。
 *
 * 骨架取自 video-shotcraft 的 124 张配方卡与 frametell 的 `motion-graphics`：
 * 钩子 → 卖点 ×N（每条一个具体证据）→ 结尾行动。
 *
 * 关键约束：**屏幕上的字必须逐字给出，不能编**。价格、版本号、功能名
 * 写错一个，整个视频就废了。没有提供的数字一律不写。
 */

import type { TeachingTemplate } from '../types'

export const promoTreeTemplate: TeachingTemplate = {
  id: 'promo',
  name: '产品/卖点',
  summary: '钩子 → 卖点 ×N（每条带证据）→ 结尾行动',
  whenToUse:
    '用户要做产品介绍、功能发布、服务推广、活动预告。' +
    '屏幕上的文字必须逐字来自用户提供的内容——价格、版本、功能名不能自己编。',
  keywords: ['产品', '推广', '宣传', '发布', '卖点', '功能', '介绍视频', '演示'],
  styles: ['tech-dark', 'clean', 'screencast'],
  sections: [
    {
      role: 'establish',
      titleHint: '钩子：一句话说清它解决什么',
      lectureHints: ['{产品} 解决 {痛点}', '以前怎么做', '现在只要'],
      sceneHint: '第一秒就要有具体形状/数字，不要标题卡开场',
      kinds: ['text', 'tex', 'highlight'],
    },
    {
      role: 'change',
      titleHint: '卖点 1：{能力}',
      lectureHints: ['{能力} 是核心', '具体表现为', '对比以前'],
      sceneHint: '一个具体操作或数据，用 arrow/highlight 指向变化',
      kinds: ['arrow', 'highlight', 'table'],
    },
    {
      role: 'change',
      titleHint: '卖点 2：{能力}',
      lectureHints: ['第二点', '它省下的是', '数字是 {真实数据}'],
      sceneHint: '另一个角度的证据，不要重复卖点 1 的视觉',
      kinds: ['table', 'tex', 'curve'],
    },
    {
      role: 'hold',
      titleHint: '结尾：下一步做什么',
      lectureHints: ['{行动号召}', '在哪找到', '一句话'],
      sceneHint: '干净的结尾帧，只留一句话与一个动作',
      kinds: ['text', 'highlight'],
    },
  ],
  roles: [
    { id: 'claim', kind: 'text', purpose: '一句话卖点' },
    { id: 'proof', kind: 'table', purpose: '支撑它的数据' },
    { id: 'cta', kind: 'text', purpose: '结尾的行动' },
  ],
  example: {
    title: '一个缓存层的价值',
    lectureLines: ['接口每次都要查库', '加了缓存之后', '命中率 92%', '响应从 120ms 到 5ms'],
    scene: [
      {
        elements: [
          { kind: 'text', content: '每次请求都查库', x: 15, y: 35, w: 70, h: 10, color: '#fca5a5' },
          { kind: 'tex', tex: '120\\,ms', x: 35, y: 52, w: 30, h: 12, color: '#fca5a5' },
        ],
      },
      {
        elements: [
          {
            kind: 'table',
            x: 18,
            y: 28,
            w: 64,
            h: 30,
            table: { headers: ['指标', '加缓存前'], rows: [['响应', '120 ms'], ['库查询', '100%']], highlightRow: 0 },
          },
        ],
      },
      {
        elements: [
          {
            kind: 'table',
            x: 18,
            y: 28,
            w: 64,
            h: 36,
            table: {
              headers: ['指标', '前', '后'],
              rows: [['响应', '120 ms', '5 ms'], ['库查询', '100%', '8%']],
              highlightRow: 0,
            },
          },
          { kind: 'tex', tex: '\\text{命中率 } 92\\%', x: 30, y: 70, w: 40, h: 10, color: '#86efac' },
        ],
      },
      {
        elements: [
          { kind: 'tex', tex: '120\\,ms \\rightarrow 5\\,ms', x: 22, y: 40, w: 56, h: 14, color: '#86efac' },
          { kind: 'highlight', x: 18, y: 36, w: 64, h: 22, color: '#86efac' },
        ],
      },
    ],
  },
}
