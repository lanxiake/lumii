/**
 * 文档选区的「就地改写」编排（P2 T2）
 *
 * 流程：读磁盘内容 → 校验区间/baseHash → 单轮 LLM 只产出替换文本 →
 * 清洗/长度校验 → 交给 artifact-edit 落候选稿（拼接构造，选区外字节不变）。
 *
 * LLM 调用由调用方注入（单轮服务持有取消能力），本模块不直接依赖 bridge。
 */

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  ArtifactEditFailure,
  ArtifactEditProposal,
  EditTone,
  ProposeTextRangeInput,
} from '../shared/artifact-edit-types'
import { diffText } from '../shared/text-diff'
import { resolveEditTarget, proposeTextEdit } from './artifact-edit'
import {
  MAX_SELECTION_CHARS,
  buildEditPrompt,
  checkReplacement,
  normalizeDocumentAction,
} from './artifact-edit-prompts'


const MAX_TEXT_EDIT_BYTES = 10 * 1024 * 1024

export interface SingleTurnRunner {
  run(input: {
    requestId: string
    prompt: string
    purpose: string
    maxTokens?: number
  }): Promise<
    | { ok: true; text: string }
    | { ok: false; error: string; cancelled?: boolean }
  >
}

function fail(
  error: string,
  code: ArtifactEditFailure['code'] = 'unavailable',
): ArtifactEditFailure {
  return { ok: false, error, code }
}

function sha256Text(content: string): string {
  return createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')
}

function normalizeTone(value: unknown): EditTone | undefined {
  return value === 'formal' || value === 'casual' || value === 'confident' ? value : undefined
}

export async function proposeTextRangeEdit(opts: {
  workspaceDir: string
  input: ProposeTextRangeInput
  run: SingleTurnRunner
}): Promise<ArtifactEditProposal | ArtifactEditFailure> {
  const { input } = opts
  const action = normalizeDocumentAction(input.action)
  if (!action) return fail('不支持的动作', 'invalid-scope')

  const target = await resolveEditTarget(opts.workspaceDir, input.path)
  if (!target) return fail('目标文件不存在或不在工作区内', 'invalid-path')
  if (target.bytes > MAX_TEXT_EDIT_BYTES) {
    return fail(`文件太大（${target.bytes} 字节，上限 10MB）`, 'unavailable')
  }
  if (
    !Number.isInteger(input.start) ||
    !Number.isInteger(input.end) ||
    input.start < 0 ||
    input.end <= input.start
  ) {
    return fail('替换区间非法', 'invalid-scope')
  }

  let content: string
  try {
    content = await fs.readFile(target.abs, 'utf8')
  } catch (err) {
    return fail(err instanceof Error ? err.message : '读取文件失败')
  }
  if (content.includes('\0')) return fail('目标不是文本文件', 'invalid-path')
  if (input.end > content.length) return fail('替换区间超出文件长度', 'invalid-scope')

  const baseHash = sha256Text(content)
  if (input.baseHash && input.baseHash !== baseHash) {
    return fail('文件已变化，请刷新后重试', 'conflict')
  }

  const selected = content.slice(input.start, input.end)
  if (!selected.trim()) return fail('选中内容为空', 'invalid-scope')
  if (selected.length > MAX_SELECTION_CHARS) {
    return fail(`选中文本太长（${selected.length} 字，上限 ${MAX_SELECTION_CHARS} 字）`, 'invalid-scope')
  }

  const prompt = buildEditPrompt({
    action,
    ...(normalizeTone(input.tone) ? { tone: normalizeTone(input.tone)! } : {}),
    selected,
    before: content.slice(0, input.start),
    after: content.slice(input.end),
    fileName: path.basename(target.rel),
    ...(input.instruction ? { instruction: input.instruction } : {}),
  })

  const result = await opts.run.run({
    requestId: input.editId,
    prompt,
    purpose: 'artifact-edit',
    maxTokens: 2000,
  })
  if (!result.ok) {
    return fail(result.error, result.cancelled ? 'cancelled' : 'unavailable')
  }

  const checked = checkReplacement(selected, result.text)
  if (!checked.ok) return fail(checked.reason, 'invalid-scope')

  // 保持文件既有的换行风格：CRLF 文件里模型给的多行内容也要用 CRLF
  const replacement = /\r\n/.test(content)
    ? checked.text.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n')
    : checked.text

  const proposal = await proposeTextEdit({
    workspaceDir: opts.workspaceDir,
    input: {
      editId: input.editId,
      path: target.rel,
      start: input.start,
      end: input.end,
      replacement,
      action,
      baseHash,
      ...(input.sessionKey !== undefined ? { sessionKey: input.sessionKey } : {}),
      ...(input.instruction ? { instruction: input.instruction } : {}),
    },
  })
  if (!proposal.ok) return proposal

  const nextContent = content.slice(0, input.start) + replacement + content.slice(input.end)
  return {
    ...proposal,
    diff: diffText(content, nextContent, path.basename(target.rel)),
  }
}
