// @vitest-environment node
/**
 * 工作台评论（P2 T8）：存储隔离、上限、已发送标记、提示词模板与截断。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { ArtifactComment, CommentAnchor } from '../shared/workbench-comment-types'
import {
  clearCommentsForConversation,
  composeCommentPrompt,
  composeComments,
  deleteComment,
  lineOfOffset,
  listComments,
  markCommentsSent,
  saveComment,
} from './workbench-comments'

let base = ''
let root = ''
const SESSION = 'conv-12345678'
const FILE = 'outputs/x/doc.md'

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'lumii-comments-'))
  root = path.join(base, 'ws')
  await mkdir(root, { recursive: true })
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

async function save(text: string, extra: Partial<Parameters<typeof saveComment>[0]['input']> = {}) {
  return saveComment({
    workspaceDir: root,
    input: { sessionKey: SESSION, path: FILE, text, ...extra },
  })
}

async function exists(abs: string): Promise<boolean> {
  try {
    await access(abs)
    return true
  } catch {
    return false
  }
}

describe('workbench-comments 存储', () => {
  it('新增/列表/删除；按路径过滤；文件落在 .lumii/comments', async () => {
    const first = await save('太啰嗦，压缩一下', {
      anchor: { type: 'text-range', start: 10, end: 20, quote: '原文片段' },
    })
    expect(first.ok).toBe(true)
    await save('第二页换个说法', { path: 'outputs/x/deck.pptx' })

    const file = path.join(root, '.lumii', 'comments', `${SESSION}.json`)
    expect(await exists(file)).toBe(true)
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { comments: unknown[] }
    expect(parsed.comments).toHaveLength(2)

    const onlyDoc = await listComments({ workspaceDir: root, sessionKey: SESSION, path: FILE })
    expect(onlyDoc.ok).toBe(true)
    if (onlyDoc.ok) {
      expect(onlyDoc.comments).toHaveLength(1)
      expect(onlyDoc.comments[0]).toMatchObject({
        path: FILE,
        text: '太啰嗦，压缩一下',
        anchor: { type: 'text-range', start: 10, end: 20, quote: '原文片段' },
      })
    }

    const id = first.ok ? first.comment.id : ''
    expect(await deleteComment({ workspaceDir: root, sessionKey: SESSION, id })).toEqual({
      ok: true,
    })
    expect(await deleteComment({ workspaceDir: root, sessionKey: SESSION, id })).toMatchObject({
      ok: false,
      code: 'not-found',
    })
  })

  it('会话隔离：不同会话各写各的文件', async () => {
    await save('a')
    const other = await listComments({ workspaceDir: root, sessionKey: 'conv-other-99' })
    if (!other.ok) throw new Error(other.error)
    expect(other.comments).toEqual([])
  })

  it('校验：空/超长文本、非法会话与路径、坏锚点被丢弃', async () => {
    expect(await save('   ')).toMatchObject({ ok: false, code: 'invalid-scope' })
    expect(await save('x'.repeat(501))).toMatchObject({ ok: false, code: 'invalid-scope' })
    expect(
      await saveComment({
        workspaceDir: root,
        input: { sessionKey: '../etc', path: FILE, text: 'x' },
      }),
    ).toMatchObject({ ok: false, code: 'invalid-scope' })
    expect(await save('x', { path: '../secret.md' })).toMatchObject({
      ok: false,
      code: 'invalid-path',
    })

    const badAnchor = await save('没有锚点也保存', {
      anchor: { type: 'text-range', start: 10, end: 5, quote: '' } as never,
    })
    expect(badAnchor.ok).toBe(true)
    if (badAnchor.ok) expect(badAnchor.comment.anchor).toBeUndefined()
  })

  it('单会话上限 200 条', async () => {
    for (let index = 0; index < 200; index += 1) {
      const result = await save(`第 ${index} 条`)
      if (!result.ok) throw new Error(result.error)
    }
    expect(await save('第 201 条')).toMatchObject({ ok: false })
  })

  it('markSent 只在未发送时标记，返回条数；重复标记幂等', async () => {
    const a = await save('a')
    const b = await save('b')
    if (!a.ok || !b.ok) throw new Error('save failed')
    const marked = await markCommentsSent({
      workspaceDir: root,
      sessionKey: SESSION,
      ids: [a.comment.id, b.comment.id],
      messageId: 'msg-1',
      now: 1234,
    })
    expect(marked).toEqual({ ok: true, marked: 2 })
    const again = await markCommentsSent({
      workspaceDir: root,
      sessionKey: SESSION,
      ids: [a.comment.id],
    })
    expect(again).toEqual({ ok: true, marked: 0 })

    const listed = await listComments({ workspaceDir: root, sessionKey: SESSION })
    if (!listed.ok) throw new Error(listed.error)
    for (const comment of listed.comments) {
      expect(comment.sentAt).toBe(1234)
      expect(comment.sentMessageId).toBe('msg-1')
    }
  })

  it('坏 JSON 当空列表；会话删除时清理文件', async () => {
    const dir = path.join(root, '.lumii', 'comments')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, `${SESSION}.json`), '{not json')
    const listed = await listComments({ workspaceDir: root, sessionKey: SESSION })
    if (!listed.ok) throw new Error(listed.error)
    expect(listed.comments).toEqual([])

    await save('x')
    await clearCommentsForConversation({ workspaceDir: root, sessionKey: SESSION })
    expect(await exists(path.join(dir, `${SESSION}.json`))).toBe(false)
  })
})

describe('composeCommentPrompt', () => {
  const comment = (id: string, text: string, anchor?: CommentAnchor): ArtifactComment => ({
    id,
    path: FILE,
    text,
    createdAt: Number(id),
    ...(anchor ? { anchor } : {}),
  })

  it('模板：路径 + 行号 + 引用 + 收尾约束', () => {
    const composed = composeCommentPrompt({
      path: FILE,
      versionLabel: '第 3 版',
      items: [
        {
          comment: comment('1', '太啰嗦，压缩到一句话', {
            type: 'text-range',
            start: 0,
            end: 5,
            quote: '原文',
          }),
          line: 12,
        },
        {
          comment: comment('2', '改成更正式的语气', { type: 'slide', index: 2, quote: '标题' }),
        },
        { comment: comment('3', '整体再短一些') },
      ],
    })
    expect(composed.count).toBe(3)
    expect(composed.text).toContain('修改产物 `outputs/x/doc.md`（第 3 版）：')
    expect(composed.text).toContain('1. 第 12 行（“原文”）：太啰嗦，压缩到一句话')
    expect(composed.text).toContain('2. 第 3 页（“标题”）：改成更正式的语气')
    expect(composed.text).toContain('3. 整篇：整体再短一些')
    expect(composed.text).toContain('只改这些地方，其余内容保持不变')
    expect(composed.ids).toEqual(['1', '2', '3'])
  })

  it('超过 10 条 / 2000 字截断并注明剩余', () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      comment(String(index + 1), `意见 ${index + 1}`),
    )
    const byCount = composeCommentPrompt({ path: FILE, items: many.map((c) => ({ comment: c })) })
    expect(byCount.count).toBe(10)
    expect(byCount.truncated).toBe(true)
    expect(byCount.text).toContain('还有 2 条评论未包含')

    const long = composeCommentPrompt({
      path: FILE,
      items: Array.from({ length: 5 }, (_, index) => ({
        comment: comment(String(index + 1), '长'.repeat(500)),
      })),
    })
    expect(long.truncated).toBe(true)
    expect(long.count).toBeLessThan(5)
    expect(long.text.length).toBeLessThan(2600)
  })

  it('lineOfOffset 从 1 开始且夹住越界', () => {
    const content = 'a\nb\nc'
    expect(lineOfOffset(content, 0)).toBe(1)
    expect(lineOfOffset(content, 2)).toBe(2)
    expect(lineOfOffset(content, 999)).toBe(3)
  })
})

describe('composeComments', () => {
  it('读文件算行号；只带未发送；ids 过滤', async () => {
    await mkdir(path.join(root, 'outputs', 'x'), { recursive: true })
    await writeFile(path.join(root, ...FILE.split('/')), '第一行\n第二行\n第三行\n', 'utf8')
    const first = await save('改这里', {
      anchor: { type: 'text-range', start: 4, end: 7, quote: '第二行' },
    })
    const second = await save('还有这里')
    if (!first.ok || !second.ok) throw new Error('save failed')
    await markCommentsSent({
      workspaceDir: root,
      sessionKey: SESSION,
      ids: [second.comment.id],
    })

    const composed = await composeComments({
      workspaceDir: root,
      sessionKey: SESSION,
      path: FILE,
    })
    expect(composed.ok).toBe(true)
    if (!composed.ok) return
    expect(composed.count).toBe(1)
    expect(composed.text).toContain('第 2 行（“第二行”）：改这里')
    expect(composed.ids).toEqual([first.comment.id])
  })

  it('没有可带评论时给可读错误', async () => {
    expect(
      await composeComments({ workspaceDir: root, sessionKey: SESSION, path: FILE }),
    ).toMatchObject({ ok: false })
  })
})
