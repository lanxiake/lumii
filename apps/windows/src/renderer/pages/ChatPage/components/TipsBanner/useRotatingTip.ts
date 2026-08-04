import { useState, useEffect, useCallback } from 'react'

export interface InputTip {
  text: string
  command?: string
}

/** 输入框 placeholder 轮播 Tips 文案库 */
export const INPUT_TIPS: InputTip[] = [
  { text: '输入 / 可以唤出斜杠命令菜单，快速执行常用操作', command: '/' },
  { text: '按 Ctrl+N 新建对话，Ctrl+B 收起/展开侧边栏' },
  { text: '发送消息时按 Shift+Enter 换行，Enter 直接发送' },
  { text: '对话标题支持双击重命名，方便后续查找' },
  { text: '侧边栏右键会话可以置顶，重要对话不会被淹没' },
  { text: '直接拖拽文件到输入框即可上传，支持图片、PDF、代码文件' },
  { text: '上传 PDF 后可以直接提问，AI 会帮你提取关键信息' },
  { text: '发送截图给 AI，它能识别图中的文字和内容' },
  { text: '使用 /compact 命令可以压缩上下文，让长对话继续流畅运行', command: '/compact' },
  { text: '开启"自动审批"后，AI 执行工具操作无需每次手动确认' },
  { text: '切换不同 Agent 可以获得不同专业能力，比如代码助手、写作助手' },
  { text: '使用 /cron 命令设置定时任务，让 AI 定期帮你处理事务', command: '/cron' },
  { text: '在输入框选择模型，可以按需切换 AI 能力和速度' },
  { text: '描述需求时越具体越好，包含背景、目标和约束条件，AI 回答更准确' },
  { text: '如果回答不满意，可以追问"请更详细说明第2点"来深入探讨' },
  { text: '让 AI 扮演特定角色效果更好，比如"作为一名资深产品经理，帮我..."' },
  { text: '复杂任务可以分步骤来，先让 AI 给出方案，确认后再执行' },
  { text: '可以让 AI 对自己的回答进行批判和改进，输出质量会更高' },
  { text: '多个 Agent 可以并行工作，一个负责研究、一个负责写作、一个负责审核' },
  { text: 'AI 团队功能可以让不同专业的 Agent 协作完成复杂项目' },
  { text: '给 Agent 设置不同的人格和专业背景，可以获得更专业的输出' },
  { text: '内置技能库涵盖 PDF 分析、PPT 生成、合同审查等，直接描述需求即可调用' },
  { text: '发送文章链接，AI 可以自动抓取并整理成结构化笔记' },
  { text: '上传股票数据或财报，AI 可以帮你做专业的量化分析' },
]

/**
 * 轮播 Tips 文案 hook，供输入框 placeholder 使用。
 * enabled 为 false 时暂停轮播并返回 null。
 */
export function useRotatingTip(enabled: boolean, interval = 8000): string | null {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * INPUT_TIPS.length))

  const advance = useCallback((dir: 1 | -1 = 1) => {
    setIndex((i) => (i + dir + INPUT_TIPS.length) % INPUT_TIPS.length)
  }, [])

  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => advance(1), interval)
    return () => clearInterval(timer)
  }, [enabled, interval, advance])

  if (!enabled) return null
  const tip = INPUT_TIPS[index]
  return tip.command ? `${tip.text}（试试 ${tip.command}）` : tip.text
}
