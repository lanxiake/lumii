/**
 * 结构模板：`howto` —— 操作教程型。
 *
 * 骨架取自仓库里已有的 `screen-tutorial-pipeline` 技能（录屏教程的探路 → 录制 →
 * 验收），但这里是**代码绘制**版：不录屏，直接画出界面/步骤示意。
 *
 * 与 `process` 的区别：process 讲的是系统内部发生什么，howto 讲的是**用户该做什么**。
 */

import type { TeachingTemplate } from '../types'

export const howtoTemplate: TeachingTemplate = {
  id: 'howto',
  name: '操作教程',
  summary: '目标 → 前置条件 → 步骤（每步一句）→ 验收',
  whenToUse:
    '用户要教别人「怎么用一个软件/怎么完成一件事」：设置项配置、工具使用、办事流程。' +
    '每一步只做一件事，且要说清做完之后应该看到什么。',
  keywords: ['怎么用', '教程', '设置', '操作', '配置', '步骤', '如何', '手把手', '指南'],
  styles: ['screencast', 'clean', 'tech-dark'],
  sections: [
    {
      role: 'establish',
      titleHint: '目标：做完之后能得到什么',
      lectureHints: ['做完你可以 {结果}', '需要先准备好', '大概花 {时间}'],
      sceneHint: '先展示结果长什么样（示意框），让观众知道目的地',
      kinds: ['rect', 'text', 'highlight'],
    },
    {
      role: 'establish',
      titleHint: '前置：开始之前',
      lectureHints: ['你需要 {前提}', '版本要 {要求}', '找不到就问'],
      sceneHint: '用简洁的检查清单，不要一次列太多',
      kinds: ['text', 'table'],
    },
    {
      role: 'change',
      titleHint: '步骤 1：{动作}',
      lectureHints: ['打开 {位置}', '点 {按钮}', '看到 {反馈}'],
      sceneHint: '画出示意界面的一部分（rect 当控件），用 arrow/highlight 指出点击位置',
      kinds: ['rect', 'arrow', 'highlight'],
    },
    {
      role: 'change',
      titleHint: '步骤 2：{动作}',
      lectureHints: ['接着 {动作}', '填 {内容}', '注意 {易错点}'],
      sceneHint: '同一界面示意继续，只改变化的部分',
      kinds: ['rect', 'arrow', 'highlight'],
    },
    {
      role: 'hold',
      titleHint: '验收：怎么知道做对了',
      lectureHints: ['成功的话你会看到', '如果没看到', '常见原因是 {原因}'],
      sceneHint: '展示成功状态的示意 + 一个失败排查提示',
      kinds: ['rect', 'text', 'highlight'],
    },
  ],
  example: {
    title: '怎么给应用设置代理',
    lectureLines: ['先打开设置页', '找到网络设置', '填入代理地址', '点保存后验证'],
    scene: [
      {
        elements: [
          { kind: 'rect', x: 15, y: 20, w: 70, h: 60, color: '#374151' },
          { kind: 'text', content: '设置页', x: 32, y: 30, w: 36, h: 8, color: '#93c5fd' },
        ],
      },
      {
        elements: [
          { kind: 'rect', x: 15, y: 20, w: 30, h: 60, color: '#374151' },
          { kind: 'rect', x: 50, y: 20, w: 35, h: 60, color: '#1f2937' },
          { kind: 'arrow', from: { x: 44, y: 50 }, x: 48, y: 50, color: '#fde68a' },
        ],
      },
      {
        elements: [
          { kind: 'rect', x: 50, y: 20, w: 35, h: 60, color: '#1f2937' },
          { kind: 'rect', x: 55, y: 40, w: 25, h: 8, color: '#93c5fd' },
          { kind: 'highlight', x: 53, y: 37, w: 29, h: 14, color: '#fde68a' },
        ],
      },
      {
        elements: [
          { kind: 'rect', x: 55, y: 55, w: 16, h: 10, color: '#86efac' },
          { kind: 'text', content: '已连接', x: 58, y: 57, w: 12, h: 6, color: '#86efac' },
          { kind: 'arrow', from: { x: 64, y: 50 }, x: 64, y: 66, color: '#86efac' },
        ],
      },
    ],
  },
}
