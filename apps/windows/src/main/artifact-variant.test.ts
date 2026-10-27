// @vitest-environment node
/**
 * 图片同源变体（P2 T5）：参数派生、同目录新文件、其余文件不变、索引登记。
 * 用真文件系统——A2 的判据就是「只新增一份文件」。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { listEdits } from './artifact-edit'
import { createImageVariant, type GenerateImageParams } from './artifact-variant'

let root = ''
const SOURCE = 'outputs/demo/cover.png'
const FIXED_NOW = new Date(2026, 9, 27, 15, 30, 12)

async function writeAt(rel: string, bytes: string | Buffer): Promise<string> {
  const abs = path.join(root, ...rel.split('/'))
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, bytes)
  return abs
}

function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 目录下全部文件 → sha256（用于「其余文件不变」断言）；`.lumii/` 是应用自己的账本，不算产物 */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (current === dir && entry.name === '.lumii') continue
        await walk(abs)
        continue
      }
      const rel = path.relative(dir, abs).split(path.sep).join('/')
      out.set(rel, sha(await readFile(abs)))
    }
  }
  await walk(dir)
  return out
}

/** 假生图：把 params 记下来，在 outputDir 写一份后再返回路径 */
function fakeGenerator(
  calls: GenerateImageParams[],
  opts: { ext?: string; fail?: boolean } = {},
) {
  return async (params: GenerateImageParams) => {
    calls.push(params)
    if (opts.fail) throw new Error('上游生图超时')
    const ext = opts.ext ?? '.png'
    const rel = `${params.outputDir ? `${params.outputDir}/` : ''}generated_test${ext}`
    await writeAt(rel, 'VARIANT-BYTES')
    return {
      filePath: rel,
      width: params.width ?? 1024,
      height: params.height ?? 1024,
      model: params.modelId,
      revisedPrompt: `${params.prompt}（改写）`,
    }
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'lumii-variant-'))
  await writeAt(SOURCE, 'SOURCE-BYTES')
  await writeAt('outputs/demo/other.png', 'OTHER-BYTES')
  await writeAt('notes.md', '# 笔记\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('createImageVariant', () => {
  it('同模型/原始提示词/尺寸，产出同目录新文件；其余文件字节不变', async () => {
    const before = await snapshot(root)
    const calls: GenerateImageParams[] = []
    const registered: Array<{ path: string; derivedFrom: string; editId: string }> = []

    const result = await createImageVariant({
      workspaceDir: root,
      input: {
        path: SOURCE,
        model: 'nano-banana-2',
        sourcePrompt: 'a cat on a desk',
        width: 1024,
        height: 1024,
        sessionKey: 'conv-1',
      },
      generateImage: fakeGenerator(calls),
      now: FIXED_NOW,
      registerFile: (info) => registered.push(info),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path).toBe('outputs/demo/cover-variant-153012.png')
    expect(result.bytes).toBe(Buffer.byteLength('VARIANT-BYTES'))
    expect(result.editId).toMatch(/^edit-/)

    // 参数派生：原始提示词（不是 revisedPrompt）、模型、尺寸、落点 = 源目录
    expect(calls).toEqual([
      {
        prompt: 'a cat on a desk',
        modelId: 'nano-banana-2',
        width: 1024,
        height: 1024,
        outputDir: 'outputs/demo',
      },
    ])

    // 只多出一个文件，其余（含源图）字节不变
    const after = await snapshot(root)
    const added = [...after.keys()].filter((key) => !before.has(key))
    expect(added).toEqual(['outputs/demo/cover-variant-153012.png'])
    for (const [rel, hash] of before) expect(after.get(rel)).toBe(hash)

    // 索引：action=variant + derivedFrom
    const edits = await listEdits({ workspaceDir: root, sessionKey: 'conv-1' })
    expect(edits.ok).toBe(true)
    if (!edits.ok) return
    expect(edits.edits).toHaveLength(1)
    expect(edits.edits[0]).toMatchObject({
      editId: result.editId,
      path: 'outputs/demo/cover-variant-153012.png',
      action: 'variant',
      scope: { type: 'image-variant' },
      derivedFrom: SOURCE,
    })
    expect(registered).toEqual([
      {
        editId: result.editId,
        sessionKey: 'conv-1',
        path: 'outputs/demo/cover-variant-153012.png',
        absPath: path.join(root, 'outputs', 'demo', 'cover-variant-153012.png'),
        bytes: Buffer.byteLength('VARIANT-BYTES'),
        derivedFrom: SOURCE,
      },
    ])
  })

  it('指令追加在原始提示词之后', async () => {
    const calls: GenerateImageParams[] = []
    const result = await createImageVariant({
      workspaceDir: root,
      input: {
        path: SOURCE,
        model: 'gpt-image-2',
        sourcePrompt: 'a cat on a desk',
        instruction: '  改成夜景  ',
      },
      generateImage: fakeGenerator(calls),
      now: FIXED_NOW,
    })
    expect(result.ok).toBe(true)
    expect(calls[0]?.prompt).toBe('a cat on a desk\n修改要求：改成夜景')
    // 未给尺寸就不传（交给上游默认 1024）
    expect(calls[0]?.width).toBeUndefined()
    expect(calls[0]?.height).toBeUndefined()
  })

  it('同一秒内重名加序号，不覆盖已有变体', async () => {
    const calls: GenerateImageParams[] = []
    const gen = fakeGenerator(calls)
    const first = await createImageVariant({
      workspaceDir: root,
      input: { path: SOURCE, model: 'm', sourcePrompt: 'p' },
      generateImage: gen,
      now: FIXED_NOW,
    })
    expect(first.ok).toBe(true)
    // 假生成器每次都写同一个 generated_test.png；第二次调用前它会覆盖它，这没关系
    const second = await createImageVariant({
      workspaceDir: root,
      input: { path: SOURCE, model: 'm', sourcePrompt: 'p' },
      generateImage: gen,
      now: FIXED_NOW,
    })
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.path).toBe('outputs/demo/cover-variant-153012-2.png')
  })

  it('非图片 / 缺模型 / 缺提示词 / 越界路径都被拒绝', async () => {
    const calls: GenerateImageParams[] = []
    const gen = fakeGenerator(calls)
    const base = { path: SOURCE, model: 'm', sourcePrompt: 'p' }

    const notImage = await createImageVariant({
      workspaceDir: root,
      input: { ...base, path: 'notes.md' },
      generateImage: gen,
    })
    expect(notImage).toMatchObject({ ok: false, code: 'invalid-path' })

    const noModel = await createImageVariant({
      workspaceDir: root,
      input: { ...base, model: '  ' },
      generateImage: gen,
    })
    expect(noModel).toMatchObject({ ok: false, code: 'invalid-scope' })

    const noPrompt = await createImageVariant({
      workspaceDir: root,
      input: { ...base, sourcePrompt: '   ' },
      generateImage: gen,
    })
    expect(noPrompt).toMatchObject({ ok: false, code: 'invalid-scope' })

    const escape = await createImageVariant({
      workspaceDir: root,
      input: { ...base, path: '../outside.png' },
      generateImage: gen,
    })
    expect(escape).toMatchObject({ ok: false, code: 'invalid-path' })

    const badSize = await createImageVariant({
      workspaceDir: root,
      input: { ...base, width: 100.5 },
      generateImage: gen,
    })
    expect(badSize).toMatchObject({ ok: false, code: 'invalid-scope' })

    expect(calls).toHaveLength(0)
  })

  it('上游失败时不留半成品', async () => {
    const before = await snapshot(root)
    const result = await createImageVariant({
      workspaceDir: root,
      input: { path: SOURCE, model: 'm', sourcePrompt: 'p' },
      generateImage: fakeGenerator([], { fail: true }),
      now: FIXED_NOW,
    })
    expect(result).toMatchObject({ ok: false })
    expect(await snapshot(root)).toEqual(before)
  })

  it('命名沿用上游扩展名', async () => {
    const result = await createImageVariant({
      workspaceDir: root,
      input: { path: SOURCE, model: 'm', sourcePrompt: 'p' },
      generateImage: fakeGenerator([], { ext: '.webp' }),
      now: FIXED_NOW,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path).toBe('outputs/demo/cover-variant-153012.webp')
  })
})
