/**
 * 工作台评论（P2 T8）
 *
 * 设计：docs/plans/客户端UI/2026-10-27-工作台v2-P2实施计划.md §4.7
 *
 * - 存储 `<ws>/.lumii/comments/<conversationId>.json`（原子写；单会话 ≤200 条、文件 ≤512KB）；
 * - 「带着评论继续」把评论拼成一段普通 user 文本（≤10 条 / 2000 字），**只预填不发送**；
 * - 发送后由 ChatPage 调 markSent 标记；会话删除时尽力清掉对应文件。
 */

import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { normalizeArtifactPath } from '../shared/artifact-declaration'
import type { ArtifactEditFailure } from '../shared/artifact-edit-types'
import type {
  ArtifactComment,
  CommentAnchor,
  CommentComposeResult,
  CommentListResult,
  SaveCommentInput,
} from '../shared/workbench-comment-types'
import {
  MAX_COMMENT_TEXT_CHARS,
  MAX_COMMENTS_FILE_BYTES,
  MAX_COMMENTS_PER_SESSION,
  MAX_PROMPT_CHARS,
  MAX_PROMPT_COMMENTS,
} from '../shared/workbench-comment-types'

const COMMENT_DIR = '.lumii/comments'
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{3,79}$/

function fail(error: string, code: ArtifactEditFailure['code'] = 'unavailable'): ArtifactEditFailure {
  return { ok: false, error, code }
}

/** 会话 id 只留下安全字符：不信任任何外部字符串拼文件名 */
function safeSessionKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80)
  return cleaned.length >= 8 ? cleaned : null
}

function commentFile(workspaceDir: string, sessionKey: string): string {
  return path.join(workspaceDir, ...COMMENT_DIR.split('/'), `${sessionKey}.json`)
}

function newId(): string {
  return `cm-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

function readAnchor(raw: unknown): CommentAnchor | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const input = raw as Record<string, unknown>
  if (input.type === 'text-range') {
    const start = typeof input.start === 'number' ? input.start : NaN
    const end = typeof input.end === 'number' ? input.end : NaN
    const quote = typeof input.quote === 'string' ? input.quote.slice(0, 200) : ''
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) return undefined
    return { type: 'text-range', start, end, quote }
  }
  if (input.type === 'slide') {
    const index = typeof input.index === 'number' ? input.index : NaN
    const quote = typeof input.quote === 'string' ? input.quote.slice(0, 200) : ''
    if (!Number.isInteger(index) || index < 0 || index > 999) return undefined
    return { type: 'slide', index, quote }
  }
  return undefined
}

function readComments(raw: unknown): ArtifactComment[] {
  if (!Array.isArray(raw)) return []
  const out: ArtifactComment[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const input = item as Record<string, unknown>
    const id = typeof input.id === 'string' && ID_RE.test(input.id) ? input.id : null
    const relPath = typeof input.path === 'string' ? normalizeArtifactPath(input.path) : null
    const text = typeof input.text === 'string' ? input.text.slice(0, MAX_COMMENT_TEXT_CHARS) : ''
    if (!id || !relPath || !text) continue
    const createdAt =
      typeof input.createdAt === 'number' && Number.isFinite(input.createdAt) ? input.createdAt : 0
    const anchor = readAnchor(input.anchor)
    out.push({
      id,
      path: relPath,
      text,
      createdAt,
      ...(typeof input.versionId === 'string' && input.versionId
        ? { versionId: input.versionId.slice(0, 120) }
        : {}),
      ...(anchor ? { anchor } : {}),
      ...(typeof input.sentAt === 'number' && Number.isFinite(input.sentAt)
        ? { sentAt: input.sentAt }
        : {}),
      ...(typeof input.sentMessageId === 'string' && input.sentMessageId
        ? { sentMessageId: input.sentMessageId.slice(0, 120) }
        : {}),
    })
  }
  return out
}

async function loadComments(
  workspaceDir: string,
  sessionKey: string,
): Promise<ArtifactComment[]> {
  const file = commentFile(workspaceDir, sessionKey)
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > MAX_COMMENTS_FILE_BYTES) return []
    const text = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(text) as { comments?: unknown }
    return readComments(parsed?.comments)
  } catch {
    return []
  }
}

async function writeComments(
  workspaceDir: string,
  sessionKey: string,
  comments: readonly ArtifactComment[],
): Promise<void> {
  const file = commentFile(workspaceDir, sessionKey)
  const payload = JSON.stringify({ comments }, null, 0)
  if (Buffer.byteLength(payload, 'utf8') > MAX_COMMENTS_FILE_BYTES) {
    throw Object.assign(new Error('评论文件超过 512KB'), { code: 'TOO_LARGE' })
  }
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await fs.writeFile(tmp, payload, 'utf8')
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
}

export async function listComments(opts: {
  workspaceDir: string
  sessionKey: unknown
  path?: unknown
}): Promise<CommentListResult | ArtifactEditFailure> {
  const sessionKey = safeSessionKey(opts.sessionKey)
  if (!sessionKey) return fail('会话标识非法', 'invalid-scope')
  let rel: string | null = null
  if (opts.path !== undefined) {
    rel = normalizeArtifactPath(opts.path)
    if (!rel) return fail('路径非法', 'invalid-path')
  }
  const comments = await loadComments(opts.workspaceDir, sessionKey)
  const filtered = rel ? comments.filter((comment) => comment.path === rel) : comments
  return { ok: true, comments: filtered }
}

export async function saveComment(opts: {
  workspaceDir: string
  input: SaveCommentInput
}): Promise<{ ok: true; comment: ArtifactComment } | ArtifactEditFailure> {
  const sessionKey = safeSessionKey(opts.input.sessionKey)
  if (!sessionKey) return fail('会话标识非法', 'invalid-scope')
  const rel = normalizeArtifactPath(opts.input.path)
  if (!rel) return fail('路径非法', 'invalid-path')
  const text = typeof opts.input.text === 'string' ? opts.input.text.trim() : ''
  if (!text) return fail('评论内容不能为空', 'invalid-scope')
  if (text.length > MAX_COMMENT_TEXT_CHARS) {
    return fail(`评论最多 ${MAX_COMMENT_TEXT_CHARS} 字`, 'invalid-scope')
  }
  const comments = await loadComments(opts.workspaceDir, sessionKey)
  if (comments.length >= MAX_COMMENTS_PER_SESSION) {
    return fail(`单个会话最多 ${MAX_COMMENTS_PER_SESSION} 条评论，请先删掉一些`, 'invalid-scope')
  }
  const anchor = readAnchor(opts.input.anchor)
  const comment: ArtifactComment = {
    id: newId(),
    path: rel,
    text,
    createdAt: Date.now(),
    ...(typeof opts.input.versionId === 'string' && opts.input.versionId
      ? { versionId: opts.input.versionId.slice(0, 120) }
      : {}),
    ...(anchor ? { anchor } : {}),
  }
  try {
    await writeComments(opts.workspaceDir, sessionKey, [...comments, comment])
  } catch (err) {
    const code = (err as { code?: string }).code
    return fail(
      code === 'TOO_LARGE'
        ? '评论文件超过 512KB，请先删掉一些'
        : err instanceof Error
          ? err.message
          : '写入评论失败',
    )
  }
  return { ok: true, comment }
}

export async function deleteComment(opts: {
  workspaceDir: string
  sessionKey: unknown
  id: unknown
}): Promise<{ ok: true } | ArtifactEditFailure> {
  const sessionKey = safeSessionKey(opts.sessionKey)
  if (!sessionKey) return fail('会话标识非法', 'invalid-scope')
  if (typeof opts.id !== 'string' || !ID_RE.test(opts.id)) return fail('评论 id 非法', 'invalid-scope')
  const comments = await loadComments(opts.workspaceDir, sessionKey)
  const next = comments.filter((comment) => comment.id !== opts.id)
  if (next.length === comments.length) return fail('找不到这条评论', 'not-found')
  try {
    await writeComments(opts.workspaceDir, sessionKey, next)
  } catch (err) {
    return fail(err instanceof Error ? err.message : '写入评论失败')
  }
  return { ok: true }
}

export async function markCommentsSent(opts: {
  workspaceDir: string
  sessionKey: unknown
  ids: unknown
  messageId?: unknown
  now?: number
}): Promise<{ ok: true; marked: number } | ArtifactEditFailure> {
  const sessionKey = safeSessionKey(opts.sessionKey)
  if (!sessionKey) return fail('会话标识非法', 'invalid-scope')
  if (!Array.isArray(opts.ids)) return fail('评论 id 列表非法', 'invalid-scope')
  const ids = new Set(
    opts.ids.filter((id): id is string => typeof id === 'string' && ID_RE.test(id)),
  )
  if (ids.size === 0) return fail('没有要标记的评论', 'invalid-scope')
  const messageId =
    typeof opts.messageId === 'string' && opts.messageId ? opts.messageId.slice(0, 120) : undefined
  const comments = await loadComments(opts.workspaceDir, sessionKey)
  const at = opts.now ?? Date.now()
  let marked = 0
  const next = comments.map((comment) => {
    if (!ids.has(comment.id) || comment.sentAt) return comment
    marked += 1
    return { ...comment, sentAt: at, ...(messageId ? { sentMessageId: messageId } : {}) }
  })
  if (marked > 0) {
    try {
      await writeComments(opts.workspaceDir, sessionKey, next)
    } catch (err) {
      return fail(err instanceof Error ? err.message : '写入评论失败')
    }
  }
  return { ok: true, marked }
}

/** 会话删除时尽力清理（失败不影响删除流程） */
export async function clearCommentsForConversation(opts: {
  workspaceDir: string
  sessionKey: string
}): Promise<void> {
  const sessionKey = safeSessionKey(opts.sessionKey)
  if (!sessionKey) return
  await fs.rm(commentFile(opts.workspaceDir, sessionKey), { force: true }).catch(() => undefined)
}

/** 行号：按 UTF-16 偏移数换行（1-based） */
export function lineOfOffset(content: string, offset: number): number {
  const clamped = Math.max(0, Math.min(offset, content.length))
  return content.slice(0, clamped).split('\n').length
}

/**
 * 拼「带着评论继续」的 user 文本（纯函数）。
 *
 * 模板（§4.7）：路径 + 可选版本 + 编号意见（行号/页码 + 引用）+ 收尾约束。
 * 超 10 条或 2000 字截断，并在末尾注明「还有 N 条未包含」。
 */
export function composeCommentPrompt(opts: {
  path: string
  versionLabel?: string
  items: ReadonlyArray<{ comment: ArtifactComment; line?: number }>
}): { text: string; ids: string[]; count: number; truncated?: boolean } {
  const chosen: Array<{ comment: ArtifactComment; line?: number }> = []
  let used = 0
  let truncated = false
  for (const item of opts.items) {
    if (chosen.length >= MAX_PROMPT_COMMENTS) {
      truncated = true
      break
    }
    const line = formatItem(item)
    if (used + line.length > MAX_PROMPT_CHARS) {
      truncated = true
      break
    }
    chosen.push(item)
    used += line.length
  }

  const header =
    `请根据以下修改意见修改产物 \`${opts.path}\`` +
    (opts.versionLabel ? `（${opts.versionLabel}）` : '') +
    '：'
  const lines = chosen.map((item, index) => `${index + 1}. ${formatItem(item)}`)
  const footer = '只改这些地方，其余内容保持不变；改完请说明改了哪几处。'
  const rest = opts.items.length - chosen.length
  return {
    text:
      [header, ...lines, footer, ...(rest > 0 ? [`（还有 ${rest} 条评论未包含，请分批继续。）`] : [])].join(
        '\n',
      ),
    ids: chosen.map((item) => item.comment.id),
    count: chosen.length,
    ...(truncated ? { truncated: true } : {}),
  }

  function formatItem(item: { comment: ArtifactComment; line?: number }): string {
    const { comment } = item
    const anchor = comment.anchor
    if (anchor?.type === 'text-range') {
      const where = item.line ? `第 ${item.line} 行` : `偏移 ${anchor.start}`
      const quote = anchor.quote ? `（“${anchor.quote}”）` : ''
      return `${where}${quote}：${comment.text}`
    }
    if (anchor?.type === 'slide') {
      const quote = anchor.quote ? `（“${anchor.quote}”）` : ''
      return `第 ${anchor.index + 1} 页${quote}：${comment.text}`
    }
    return `整篇：${comment.text}`
  }
}

/** 组装某产物的评论提示词（读文件算行号；读不到就按偏移） */
export async function composeComments(opts: {
  workspaceDir: string
  sessionKey: unknown
  path: unknown
  ids?: unknown
  versionLabel?: unknown
}): Promise<CommentComposeResult | ArtifactEditFailure> {
  const sessionKey = safeSessionKey(opts.sessionKey)
  if (!sessionKey) return fail('会话标识非法', 'invalid-scope')
  const rel = normalizeArtifactPath(opts.path)
  if (!rel) return fail('路径非法', 'invalid-path')
  const ids = Array.isArray(opts.ids)
    ? new Set(opts.ids.filter((id): id is string => typeof id === 'string' && ID_RE.test(id)))
    : null
  const all = await loadComments(opts.workspaceDir, sessionKey)
  const candidates = all
    .filter((comment) => comment.path === rel && !comment.sentAt)
    .filter((comment) => (ids ? ids.has(comment.id) : true))
    .sort((a, b) => a.createdAt - b.createdAt)
  if (candidates.length === 0) return fail('没有可带上的评论', 'invalid-scope')

  let content: string | null = null
  try {
    content = await fs.readFile(path.join(opts.workspaceDir, ...rel.split('/')), 'utf8')
  } catch {
    content = null
  }

  const composed = composeCommentPrompt({
    path: rel,
    ...(typeof opts.versionLabel === 'string' && opts.versionLabel
      ? { versionLabel: opts.versionLabel }
      : {}),
    items: candidates.map((comment) => ({
      comment,
      ...(content && comment.anchor?.type === 'text-range'
        ? { line: lineOfOffset(content, comment.anchor.start) }
        : {}),
    })),
  })
  return { ok: true, ...composed }
}
