// @vitest-environment node
/**
 * 文档选区改写编排：只替换选区、LLM 失败/取消/过长/文件变化都不落候选。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { ProposeTextRangeInput } from '../shared/artifact-edit-types'
import { proposeTextRangeEdit, type SingleTurnRunner } from './artifact-edit-llm'

let base = ''
let root = ''
const CONTENT = '# Title\n\nHello world\n'
const START = CONTENT.indexOf('Hello world')
const END = START + 'Hello world'.length

async function writeAt(rel: string, content: string): Promise<string> {
  const abs = path.join(root, ...rel.split('/'))
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, content, 'utf8')
  return abs
}

async function readAt(rel: string): Promise<string> {
  return readFile(path.join(root, ...rel.split('/')), 'utf8')
}

async function exists(rel: string): Promise<boolean> {
  try {
    await access(path.join(root, ...rel.split('/')))
    return true
  } catch {
    return false
  }
}

function runner(
  text: string,
  beforeReturn?: () => Promise<void>,
): { runner: SingleTurnRunner; prompt: () => string } {
  let prompt = ''
  return {
    prompt: () => prompt,
    runner: {
      run: async (input) => {
        prompt = input.prompt
        await beforeReturn?.()
        return { ok: true, text }
      },
    },
  }
}

function input(overrides: Partial<ProposeTextRangeInput> = {}): ProposeTextRangeInput {
  return {
    editId: 'edit-llm-test-1',
    path: 'outputs/demo/doc.md',
    start: START,
    end: END,
    action: 'rewrite',
    ...overrides,
  }
}

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'lumii-edit-llm-'))
  root = path.join(base, 'ws')
  await mkdir(root, { recursive: true })
  await writeAt('outputs/demo/doc.md', CONTENT)
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('proposeTextRangeEdit', () => {
  it('只拼接受影响区间，返回候选与 diff；目标文件不变', async () => {
    const fake = runner('Hello Lumii')
    const result = await proposeTextRangeEdit({
      workspaceDir: root,
      input: input(),
      run: fake.runner,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.diff?.insertions).toBe(1)
    expect(result.diff?.deletions).toBe(1)
    expect(await readAt('outputs/demo/doc.md')).toBe(CONTENT)
    expect(await readAt(result.candidatePath)).toBe('# Title\n\nHello Lumii\n')
    expect(fake.prompt()).toContain('Hello world')
    expect(fake.prompt()).toContain('doc.md')
  })

  it('LLM 取消/失败/原样返回/过长都不落候选', async () => {
    const cancelled = await proposeTextRangeEdit({
      workspaceDir: root,
      input: input(),
      run: { run: async () => ({ ok: false, error: '已取消', cancelled: true }) },
    })
    expect(cancelled).toMatchObject({ ok: false, code: 'cancelled' })
    expect(await exists('.lumii/edits/edit-llm-test-1')).toBe(false)

    const same = await proposeTextRangeEdit({
      workspaceDir: root,
      input: input(),
      run: runner('Hello world').runner,
    })
    expect(same).toMatchObject({ ok: false })

    const tooLong = await proposeTextRangeEdit({
      workspaceDir: root,
      input: input(),
      run: runner('x'.repeat(5000)).runner,
    })
    expect(tooLong).toMatchObject({ ok: false })
    expect(await exists('.lumii/edits/edit-llm-test-1')).toBe(false)
  })

  it('baseHash 不符时在调用 LLM 前就拒绝', async () => {
    const run = vi.fn(async () => ({ ok: true as const, text: 'changed' }))
    const result = await proposeTextRangeEdit({
      workspaceDir: root,
      input: input({ baseHash: 'deadbeef' }),
      run: { run },
    })
    expect(result).toMatchObject({ ok: false, code: 'conflict' })
    expect(run).not.toHaveBeenCalled()
  })

  it('LLM 期间文件被改：候选不落盘', async () => {
    const fake = runner('Hello Lumii', async () => {
      await writeAt('outputs/demo/doc.md', '# changed elsewhere\n')
    })
    const result = await proposeTextRangeEdit({
      workspaceDir: root,
      input: input(),
      run: fake.runner,
    })
    expect(result).toMatchObject({ ok: false, code: 'conflict' })
    expect(await readAt('outputs/demo/doc.md')).toBe('# changed elsewhere\n')
    expect(await exists('.lumii/edits/edit-llm-test-1')).toBe(false)
  })

  it('CRLF 文件：模型的多行输出也转成 CRLF，不制造混合换行', async () => {
    const crlf = '# T\r\n\r\nHello world\r\n'
    await writeAt('outputs/demo/crlf.md', crlf)
    const start = crlf.indexOf('Hello world')
    const result = await proposeTextRangeEdit({
      workspaceDir: root,
      input: input({
        editId: 'edit-crlf-1',
        path: 'outputs/demo/crlf.md',
        start,
        end: start + 'Hello world'.length,
        action: 'expand',
      }),
      run: runner('Hello\nworld').runner,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const candidate = await readAt(result.candidatePath)
    expect(candidate).toBe('# T\r\n\r\nHello\r\nworld\r\n')
    expect(candidate.match(/(?<!\r)\n/g)).toBeNull()
  })

  it('选中内容过长直接拒绝', async () => {
    const big = `# T\n\n${'x'.repeat(5000)}\n`
    await writeAt('outputs/big/doc.md', big)
    const run = vi.fn(async () => ({ ok: true as const, text: 'y' }))
    const result = await proposeTextRangeEdit({
      workspaceDir: root,
      input: input({ path: 'outputs/big/doc.md', start: 5, end: big.length - 1 }),
      run: { run },
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid-scope' })
    expect(run).not.toHaveBeenCalled()
  })
})
