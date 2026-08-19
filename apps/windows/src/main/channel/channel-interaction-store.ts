/**
 * ChannelInteractionStore —— 渠道侧「提问 / 审批」挂起态
 *
 * 桌面端提问与审批走 IPC 弹窗；渠道（飞书/企微/微信）没有弹窗，
 * 需要把请求文字化推给用户，并把用户的下一条文字回复当成答案回填。
 *
 * 只存「sessionKey → 当前挂起的一个交互」：同一会话的 Agent 循环是串行的，
 * 同一时刻最多有一个提问或审批在等，不需要队列。
 */

import type { ChannelSession, IChannelAdapter } from './types'

export type ChannelInteraction =
  | {
      kind: 'ask'
      requestId: string
      /** 问题 header → 可选项 label 列表，用于解析用户回复的序号 */
      questions: readonly {
        question: string
        header: string
        multiSelect: boolean
        options: readonly { label: string; description?: string }[]
      }[]
    }
  | {
      kind: 'permission'
      requestId: string
      toolName: string
    }

interface PendingEntry {
  interaction: ChannelInteraction
  adapter: IChannelAdapter
  session: ChannelSession
}

export class ChannelInteractionStore {
  private readonly pending = new Map<string, PendingEntry>()

  /** 登记挂起交互；同一会话的旧交互被覆盖（Agent 串行，旧的必然已失效） */
  set(sessionKey: string, entry: PendingEntry): void {
    this.pending.set(sessionKey, entry)
  }

  get(sessionKey: string): PendingEntry | undefined {
    return this.pending.get(sessionKey)
  }

  delete(sessionKey: string): void {
    this.pending.delete(sessionKey)
  }

  /** 会话被 /clear、/new、abort 时清空，避免陈旧交互吃掉下一条正常消息 */
  clear(sessionKey: string): void {
    this.pending.delete(sessionKey)
  }
}

/** 渠道审批的三个可选回复 → 决策 */
const PERMISSION_REPLIES: Record<string, 'allow-once' | 'allow-always' | 'deny'> = {
  '1': 'allow-once',
  '2': 'allow-always',
  '3': 'deny',
  y: 'allow-once',
  yes: 'allow-once',
  同意: 'allow-once',
  允许: 'allow-once',
  always: 'allow-always',
  总是允许: 'allow-always',
  n: 'deny',
  no: 'deny',
  拒绝: 'deny',
}

/** 把用户文字解析成审批决策；无法识别返回 null（提示用户重发） */
export function parsePermissionReply(text: string): 'allow-once' | 'allow-always' | 'deny' | null {
  return PERMISSION_REPLIES[text.trim().toLowerCase()] ?? null
}

/** 渠道审批提示文案 */
export function formatPermissionPrompt(toolName: string, description?: string): string {
  return [
    `🔐 需要你的审批：Agent 想执行工具 \`${toolName}\``,
    description ? `说明：${description}` : '',
    '',
    '请回复：',
    '1 = 本次允许    2 = 一直允许    3 = 拒绝',
  ]
    .filter(Boolean)
    .join('\n')
}

/** 渠道提问提示文案：每个问题列出带序号的选项 */
export function formatAskPrompt(
  questions: Extract<ChannelInteraction, { kind: 'ask' }>['questions'],
): string {
  const blocks = questions.map((q, qi) => {
    const opts = q.options.map((o, oi) => `  ${oi + 1}. ${o.label}`).join('\n')
    const multiHint = q.multiSelect ? '（可多选，用逗号分隔序号）' : ''
    return `${questions.length > 1 ? `【问题 ${qi + 1}】` : ''}${q.question}${multiHint}\n${opts}`
  })
  return [
    '❓ Agent 需要你确认：',
    '',
    ...blocks,
    '',
    questions.length > 1
      ? '请按顺序回复各题答案，用换行或分号分隔（也可直接文字作答）。'
      : '请回复选项序号，或直接用文字作答。',
  ].join('\n')
}

/**
 * 把用户文字解析成 ask 答案：answers 以 header 为 key。
 *
 * 序号命中选项则取 label，否则原文作答（模型能读懂自由文本）。
 */
export function parseAskReply(
  questions: Extract<ChannelInteraction, { kind: 'ask' }>['questions'],
  text: string,
): Record<string, string> {
  const parts = text
    .split(/[\n;；]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const answers: Record<string, string> = {}

  questions.forEach((q, i) => {
    // 单问题时整段文字都归它，多问题才按分隔切
    const raw = questions.length === 1 ? text.trim() : (parts[i] ?? '')
    if (!raw) return
    const picked = raw
      .split(/[,，]+/)
      .map((token) => {
        const idx = Number(token.trim())
        return Number.isInteger(idx) && idx >= 1 && idx <= q.options.length
          ? q.options[idx - 1]!.label
          : null
      })
      .filter((v): v is string => v !== null)
    answers[q.header] = picked.length > 0 ? picked.join(', ') : raw
  })

  return answers
}
