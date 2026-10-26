/**
 * 工作台卡片状态（AG-UI「状态视图」的本地子集）
 *
 * 只回答一件事：**当前回合的工具现在应该是哪张卡、什么状态、能给什么动作**。
 * - running / failed / cancelled 来自工具 part；
 * - ready 由台账（声明 + fileChanges）负责，本文件不重复造。
 *
 * 历史轮次的失败卡不在这里堆积：rail 只展示**最后一条 assistant 消息**的工具状态，
 * 旧的失败仍能在消息时间线里看到。
 */

import type { ArtifactKind, ArtifactMeta } from '@mtbot/agent-runtime/browser'

export type CardLifecycle = 'running' | 'waiting_input' | 'ready' | 'failed' | 'cancelled'

export type CardAction =
  | 'abort'
  | 'retry'
  | 'open'
  | 'export'
  | 'locate'
  | 'compare'
  | 'remove'
  | 'allow-once'
  | 'allow-always'
  | 'deny'
  | 'answer'

export interface ToolPartLike {
  readonly type: string
  readonly id: string
  readonly name?: string
  readonly args?: Record<string, unknown>
  readonly result?: unknown
  readonly isError?: boolean
  readonly status?: string
  readonly progressText?: string
}

export interface CardMessageLike {
  readonly id: string
  readonly role: string
  readonly timestamp: number
  readonly isStreaming?: boolean
  readonly parts?: readonly ToolPartLike[]
}

export interface ArtifactCardState {
  /** 稳定 id：占位 `tool:<toolCallId>`；ready 用路径 */
  id: string
  toolCallId?: string
  turnId: string
  timestamp: number
  kind: ArtifactKind
  lifecycle: CardLifecycle
  /** 卡片标题（占位用阶段名 / 文件名；ready 用文件名） */
  title?: string
  /** ready 时才有 */
  path?: string
  meta?: ArtifactMeta
  /** running 占位：只承诺「用户能看懂在做什么」，不承诺文件存在 */
  placeholder?: { prompt?: string; fileName?: string }
  /** failed 的用户可读原因（≤160 字） */
  error?: string
  /** 重试只预填 prompt，不自动发送 */
  retry?: { toolName: string; prompt?: string }
}

interface ProducerRule {
  test: (name: string) => boolean
  kind: ArtifactKind
  label: string
}

/**
 * 只列「运行中有意义、结束后能落到 rail」的产出工具。
 *
 * - `enqueue_workflow`：tool 很快返回占位结果，真正产出在后台任务卡里；这里造
 *   running 卡会「闪一下就消失」，反而误导；
 * - `screen_record_*`：产物在数据根 `recordings/`，不是工作区相对路径，rail 无法打开。
 * 两者继续由聊天内的工具卡/后台任务卡展示，等 P2 有远端产物卡再收进来。
 */
const PRODUCERS: readonly ProducerRule[] = [
  { test: (name) => name === 'image_generate', kind: 'image', label: '生成图片' },
]

function producerOf(name: string | undefined): ProducerRule | undefined {
  if (!name) return undefined
  const normalized = name.toLowerCase()
  return PRODUCERS.find((rule) => rule.test(normalized))
}

function promptOf(args: Record<string, unknown> | undefined): string | undefined {
  const prompt = args?.prompt
  if (typeof prompt === 'string' && prompt.trim()) return prompt.trim()
  const description = args?.description
  return typeof description === 'string' && description.trim() ? description.trim() : undefined
}

function fileNameOf(args: Record<string, unknown> | undefined): string | undefined {
  for (const key of ['filename', 'fileName', 'outputPath']) {
    const value = args?.[key]
    if (typeof value === 'string' && value.trim()) {
      const base = value.replace(/\\/g, '/').split('/').pop()
      if (base) return base
    }
  }
  return undefined
}

/** 工具失败结果的用户可读摘要（pi 失败时 details 会被清空，只剩 content/message） */
export function summarizeToolError(part: ToolPartLike): string {
  const result = part.result
  if (typeof result === 'string' && result.trim()) return result.trim().slice(0, 160)
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>
    if (typeof record.message === 'string' && record.message.trim()) {
      return record.message.trim().slice(0, 160)
    }
    if (typeof record.error === 'string' && record.error.trim()) {
      return record.error.trim().slice(0, 160)
    }
    const content = record.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object') {
          const text = (block as Record<string, unknown>).text
          if (typeof text === 'string' && text.trim()) return text.trim().slice(0, 160)
        }
      }
    }
  }
  return '工具执行失败'
}

function lifecycleOf(part: ToolPartLike, streaming: boolean): CardLifecycle | null {
  if (part.status === 'running') return streaming ? 'running' : 'cancelled'
  if (part.status === 'error' || part.isError) return 'failed'
  if (part.status === 'interrupted') return 'cancelled'
  return null
}

const cardCache = new WeakMap<object, ArtifactCardState[]>()

/**
 * 最后一条 assistant 消息 → 占位/失败/取消卡。
 * 同一消息对象命中 WeakMap：流式时只有最后一条会重算。
 */
export function buildCardStates(messages: readonly CardMessageLike[]): ArtifactCardState[] {
  let last: CardMessageLike | undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role === 'assistant' && (message.parts?.length ?? 0) > 0) {
      last = message
      break
    }
  }
  if (!last) return []

  const cached = cardCache.get(last)
  if (cached) return cached

  const cards: ArtifactCardState[] = []
  const streaming = last.isStreaming === true
  for (const part of last.parts ?? []) {
    if (part.type !== 'tool') continue
    const producer = producerOf(part.name)
    if (!producer) continue
    const lifecycle = lifecycleOf(part, streaming)
    if (!lifecycle) continue

    const prompt = promptOf(part.args)
    const fileName = fileNameOf(part.args)
    const card: ArtifactCardState = {
      id: `tool:${part.id}`,
      toolCallId: part.id,
      turnId: last.id,
      timestamp: last.timestamp,
      kind: producer.kind,
      lifecycle,
      title: fileName ?? producer.label,
      ...(prompt || fileName
        ? { placeholder: { ...(prompt ? { prompt } : {}), ...(fileName ? { fileName } : {}) } }
        : {}),
    }
    if (lifecycle === 'failed') card.error = summarizeToolError(part)
    if (part.name && prompt) {
      card.retry = { toolName: part.name, prompt }
    }
    cards.push(card)
  }

  cards.sort((a, b) => b.timestamp - a.timestamp)
  cardCache.set(last, cards)
  return cards
}

/** 一级动作（最多 5 个）；不可用的动作不出现 */
export function actionsForCard(card: ArtifactCardState): CardAction[] {
  switch (card.lifecycle) {
    case 'running':
      return ['abort']
    case 'waiting_input':
      return ['allow-once', 'allow-always', 'deny']
    case 'ready':
      return ['open', 'export', 'locate', 'compare']
    case 'failed':
      return card.retry?.prompt ? ['retry', 'locate'] : ['locate']
    case 'cancelled':
      return card.retry?.prompt ? ['retry', 'remove'] : ['remove']
    default:
      return []
  }
}
