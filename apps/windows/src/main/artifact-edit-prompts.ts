/**
 * 就地修改的提示词与输出清洗（P2 T2）
 *
 * 约束（设计 §7.3 / 计划 T2）：
 * - 只让模型产出「替换选中区间」的内容；
 * - 清洗围栏/引号/「修改后：」前缀；
 * - 过长或与原内容相同一律拒绝，避免「整篇重写」伪装局部。
 */

import type { DocumentEditAction, EditTone } from '../shared/artifact-edit-types'

export type { DocumentEditAction, EditTone } from '../shared/artifact-edit-types'

export const MAX_SELECTION_CHARS = 4000
export const CONTEXT_CHARS = 200
const MAX_OUTPUT_CHARS = 20_000

const TONE_LABEL: Record<EditTone, string> = {
  formal: '正式',
  casual: '口语化',
  confident: '自信、有说服力',
}

export interface BuildEditPromptInput {
  action: DocumentEditAction
  tone?: EditTone
  selected: string
  before: string
  after: string
  fileName: string
  instruction?: string
}

function actionInstruction(action: DocumentEditAction, tone?: EditTone): string {
  switch (action) {
    case 'rewrite':
      return '在不改变原意的前提下，把选中内容改写得更通顺、自然。'
    case 'expand':
      return '扩写选中内容，补充必要的细节与衔接，长度约为原文的 1.5–2 倍。'
    case 'shorten':
      return '精简选中内容，保留关键信息，长度不超过原文的 60%。'
    case 'tone':
      return `把语气改为「${TONE_LABEL[tone ?? 'formal']}」，不改变事实与结构。`
    default:
      return '按用户要求修改选中内容。'
  }
}

export function buildEditPrompt(input: BuildEditPromptInput): string {
  const before = input.before.slice(-CONTEXT_CHARS)
  const after = input.after.slice(0, CONTEXT_CHARS)
  const parts = [
    '你是文本编辑助手。请按下面的要求修改「选中内容」，只输出修改后的内容本身：',
    '- 不要解释、不要加引号、不要用代码围栏；',
    '- 保留原有的 Markdown 语法（标题、列表、强调等）；',
    '- 不要改动选中内容以外的部分。',
    '',
    `文件：${input.fileName}`,
  ]
  if (before) parts.push('', '选中内容之前的上下文：', before)
  parts.push('', '选中内容：', '<<<', input.selected, '>>>')
  if (after) parts.push('', '选中内容之后的上下文：', after)
  parts.push('', `要求：${actionInstruction(input.action, input.tone)}`)
  if (input.instruction?.trim()) parts.push(`附加要求：${input.instruction.trim().slice(0, 500)}`)
  return parts.join('\n')
}

/** 去掉整段围栏、首尾引号与常见前缀 */
export function cleanLlmReplacement(raw: string): string {
  let text = raw.trim()
  if (!text) return ''

  const fence = text.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/)
  if (fence) text = (fence[1] ?? '').trim()

  text = text.replace(/^(修改后|改写后|结果|输出)[:：]\s*/, '')

  const wrappers: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['「', '」'],
    ['『', '』'],
  ]
  for (const [open, close] of wrappers) {
    if (text.length > 2 && text.startsWith(open) && text.endsWith(close)) {
      text = text.slice(1, -1).trim()
      break
    }
  }
  return text
}

export type ReplacementCheck =
  | { ok: true; text: string }
  | { ok: false; reason: string }

export function checkReplacement(selected: string, raw: string): ReplacementCheck {
  const text = cleanLlmReplacement(raw)
  if (!text) return { ok: false, reason: '模型没有返回可用的改写内容' }
  if (text.length > MAX_OUTPUT_CHARS) {
    return { ok: false, reason: '模型返回过长，已拒绝' }
  }
  if (text === selected.trim()) {
    return { ok: false, reason: '模型建议与原内容相同' }
  }
  const limit = Math.max(Math.ceil(selected.length * 3), 4000)
  if (text.length > limit) {
    return { ok: false, reason: '模型返回过长（超过原文 3 倍），已拒绝整篇重写' }
  }
  return { ok: true, text }
}

/** 把渲染层传的 action 收敛到文档可用的四种 */
export function normalizeDocumentAction(value: unknown): DocumentEditAction | null {
  return value === 'rewrite' || value === 'expand' || value === 'shorten' || value === 'tone'
    ? value
    : null
}

