/**
 * 结构模板：`process` —— 流程/步骤型。
 *
 * 骨架取自 explainroo 的 `steps` 版式：初始态 → 步骤 1..N → 终态。
 * 适合协议、算法、操作流程、审批链路。
 *
 * 关键约束：**每步只有一个动作，且状态可见**。流程型视频最常见的失败是
 * 「一口气把五步画完」，观众只看到结果没看到过程。
 */

import type { TeachingTemplate } from '../types'

export const processTemplate: TeachingTemplate = {
  id: 'process',
  name: '流程/步骤',
  summary: '初始态 → 步骤 1..N（每步一个动作）→ 终态',
  whenToUse:
    '用户要讲「怎么做的」「经过哪些步骤」：协议握手、算法执行、操作流程、审批链路、装配顺序。' +
    '每步只能有一个动作，且每步之后的状态要看得见。',
  keywords: ['流程', '步骤', '过程', '怎么做', '执行', '握手', '算法', '顺序', '链路'],
  styles: ['clean', 'tech-dark', 'screencast'],
  sections: [
    {
      role: 'establish',
      titleHint: '起点：谁发给谁',
      lectureHints: ['一开始只有 {初始态}', '两个角色分别是', '谁先动'],
      sceneHint: '两个角色（或两个状态）并排出现，中间留出信道',
      kinds: ['rect', 'text', 'arrow'],
    },
    {
      role: 'change',
      titleHint: '第 1 步：{动作}',
      lectureHints: ['{A} 发出 {消息}', '带上 {关键信息}', '为什么要有这一步'],
      sceneHint: 'arrow 从 A 指向 B，消息内容用 text 标在箭头上方',
      kinds: ['arrow', 'text', 'highlight'],
    },
    {
      role: 'change',
      titleHint: '第 2 步：{回应}',
      lectureHints: ['{B} 收到后 {动作}', '返回 {应答}', '到这一步还不能确认'],
      sceneHint: '反向的 arrow，箭头颜色区分方向',
      kinds: ['arrow', 'text', 'highlight'],
    },
    {
      role: 'change',
      titleHint: '第 3 步：{收尾}',
      lectureHints: ['{A} 再发 {确认}', '双方状态同步', '整个流程完成'],
      sceneHint: '第三支 arrow，两端状态同时变为「已连接」',
      kinds: ['arrow', 'text', 'highlight'],
    },
    {
      role: 'hold',
      titleHint: '回看：为什么需要这么多步',
      lectureHints: ['少一步会怎样', '每步解决什么', '记住这三步'],
      sceneHint: '把三步箭头的缩略图排成一行，用 brace 括起来',
      kinds: ['brace', 'text', 'code'],
    },
  ],
  example: {
    title: 'TCP 三次握手',
    lectureLines: ['客户端先发 SYN', '服务器回 SYN+ACK', '客户端再发 ACK', '三次之后才开始传数据'],
    scene: [
      // 第一步只立出两个角色（标签随后续步骤出现在箭头旁）
      {
        elements: [
          { kind: 'rect', x: 8, y: 20, w: 22, h: 12, color: '#93c5fd' },
          { kind: 'text', content: '客户端', x: 12, y: 23, w: 14, h: 6 },
          { kind: 'rect', x: 70, y: 20, w: 22, h: 12, color: '#86efac' },
        ],
      },
      {
        elements: [
          { kind: 'text', content: '服务器', x: 74, y: 23, w: 14, h: 6 },
          { kind: 'rect', x: 8, y: 20, w: 22, h: 12, color: '#93c5fd' },
          { kind: 'arrow', from: { x: 30, y: 50 }, x: 70, y: 50, color: '#fde68a' },
        ],
      },
      {
        elements: [
          { kind: 'text', content: 'SYN', x: 46, y: 40, w: 10, h: 6, color: '#fde68a' },
          { kind: 'arrow', from: { x: 70, y: 64 }, x: 30, y: 64, color: '#fca5a5' },
          { kind: 'text', content: 'SYN+ACK', x: 42, y: 72, w: 18, h: 6, color: '#fca5a5' },
        ],
      },
      {
        elements: [
          { kind: 'arrow', from: { x: 30, y: 78 }, x: 70, y: 78, color: '#86efac' },
          { kind: 'text', content: 'ACK', x: 46, y: 86, w: 10, h: 6, color: '#86efac' },
        ],
      },
      {
        elements: [
          { kind: 'text', content: 'SYN → SYN+ACK → ACK', x: 8, y: 40, w: 84, h: 10, color: '#93c5fd' },
          { kind: 'brace', from: { x: 4, y: 36 }, to: { x: 4, y: 54 }, color: '#fde68a' },
          { kind: 'text', content: '三步都为了确认双向可达', x: 8, y: 62, w: 84, h: 8 },
        ],
      },
    ],
  },
}
