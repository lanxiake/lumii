// @vitest-environment node
/**
 * PPT 页列表（jszip/OOXML）与单页写回（受管 Python）的语义不变量。
 */
import { describe, expect, it, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
import JSZip from 'jszip'
import { checkPptxDeps, proposeSlideEdit, readSlideOutline, runPptxPageEdit } from './artifact-slides'
import { applyEdit } from './artifact-edit'
import { getBundledPythonExe } from './python-env'

function canImportPptx(): boolean {
  try {
    execFileSync(getBundledPythonExe(), ['-c', 'import pptx'], { timeout: 10_000 })
    return true
  } catch {
    return false
  }
}
// 用户 site-packages 也算；不能只看 bundled hasPackage
const CAN_RUN_PPTX = process.platform === 'win32' && canImportPptx()

let tempDir = ''

afterEach(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true })
  tempDir = ''
  delete process.env.LUMII_PPTX_EDIT_SCRIPT
})

function slideXml(title: string, lines: string[]): string {
  const paras = [title, ...lines]
    .map((text) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody>${paras}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
}

async function writeMinimalPptx(file: string, slides: Array<[string, string[]]>): Promise<void> {
  const zip = new JSZip()
  slides.forEach(([title, lines], index) => {
    zip.file(`ppt/slides/slide${index + 1}.xml`, slideXml(title, lines))
  })
  await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }))
}

describe('readSlideOutline', () => {
  it('按页号提取标题/正文/形状数，并解码 XML 实体', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumii-slides-'))
    const file = path.join(tempDir, 'deck.pptx')
    await writeMinimalPptx(file, [
      ['第一页 &amp; 标题', ['A1', 'B1']],
      ['Page 2', ['A2']],
      ['Page 3', ['A3', 'B3']],
    ])
    const result = await readSlideOutline(file)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.slides).toHaveLength(3)
    expect(result.slides[0]).toMatchObject({
      index: 0,
      title: '第一页 & 标题',
      lines: ['第一页 & 标题', 'A1', 'B1'],
      shapes: 1,
    })
    expect(result.slides[2]?.index).toBe(2)
  })

  it('坏文件返回可读错误', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumii-slides-'))
    const file = path.join(tempDir, 'bad.pptx')
    await fs.writeFile(file, 'not a zip')
    const result = await readSlideOutline(file)
    expect(result.ok).toBe(false)
    // 底层 JSZip 错误不能直接冒给用户
    if (!result.ok) expect(result.error).toBe('不是有效的 PPTX 文件')
  })
})

describe('runPptxPageEdit', () => {
  it.skipIf(!CAN_RUN_PPTX)('只改第 3 页：其余页文本/shape 数不变', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumii-slides-'))
    const fixture = path.join(tempDir, 'fixture.pptx')
    const output = path.join(tempDir, 'edited.pptx')
    const python = getBundledPythonExe()
    const create = `
from pptx import Presentation
import sys
prs = Presentation()
for i in range(4):
    slide = prs.slides.add_slide(prs.slide_layouts[1])
    slide.shapes.title.text = f"Page {i+1} title"
    tf = slide.placeholders[1].text_frame
    tf.text = f"Point A{i+1}"
    tf.add_paragraph().text = f"Point B{i+1}"
prs.save(sys.argv[1])
`
    execFileSync(python, ['-c', create, fixture], { timeout: 30_000 })
    process.env.LUMII_PPTX_EDIT_SCRIPT = path.resolve(process.cwd(), 'resources/scripts/pptx_page_edit.py')

    const before = await readSlideOutline(fixture)
    expect(before.ok).toBe(true)
    if (!before.ok) return

    await runPptxPageEdit({
      python,
      inputAbs: fixture,
      outputAbs: output,
      slideIndex: 2,
      spec: { title: 'Page 3 rewritten', bullets: ['New bullet one', 'New bullet two'] },
    })

    const after = await readSlideOutline(output)
    expect(after.ok).toBe(true)
    if (!after.ok) return

    for (const index of [0, 1, 3]) {
      expect(after.slides[index]).toEqual(before.slides[index])
    }
    expect(after.slides[2]?.title).toBe('Page 3 rewritten')
    expect(after.slides[2]?.lines).toEqual([
      'Page 3 rewritten',
      'New bullet one',
      'New bullet two',
    ])
    expect(after.slides[2]?.shapes).toBe(before.slides[2]?.shapes)
  })

  it('依赖检查返回可读结论', async () => {
    const deps = await checkPptxDeps()
    expect(typeof deps.ok).toBe('boolean')
    if (!deps.ok) expect(deps.reason).toBeTruthy()
  })
})

describe('proposeSlideEdit', () => {
  it.skipIf(!CAN_RUN_PPTX)('LLM 只产出 JSON，候选写回目标页；应用后源文件才变化', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumii-slides-'))
    const dir = path.join(tempDir, 'outputs', 'a')
    await fs.mkdir(dir, { recursive: true })
    const fixture = path.join(dir, 'deck.pptx')
    const python = getBundledPythonExe()
    const create = `
from pptx import Presentation
import sys
prs = Presentation()
for i in range(3):
    slide = prs.slides.add_slide(prs.slide_layouts[1])
    slide.shapes.title.text = f"Page {i+1}"
    slide.placeholders[1].text_frame.text = f"Point {i+1}"
prs.save(sys.argv[1])
`
    execFileSync(python, ['-c', create, fixture], { timeout: 30_000 })
    process.env.LUMII_PPTX_EDIT_SCRIPT = path.resolve(
      process.cwd(),
      'resources/scripts/pptx_page_edit.py',
    )

    const proposal = await proposeSlideEdit({
      workspaceDir: tempDir,
      input: {
        editId: 'edit-slide-1',
        path: 'outputs/a/deck.pptx',
        index: 1,
        action: 'slide-title',
      },
      run: {
        run: async () => ({ ok: true, text: '{"title":"New page 2"}' }),
      },
    })
    expect(proposal.ok).toBe(true)
    if (!proposal.ok) return
    expect(proposal.slides?.[1]?.title).toBe('New page 2')
    // 候选不碰源文件
    const beforeApply = await readSlideOutline(fixture)
    expect(beforeApply.ok && beforeApply.slides[1]?.title).toBe('Page 2')

    const applied = await applyEdit({ workspaceDir: tempDir, editId: proposal.editId })
    expect(applied.ok).toBe(true)
    const afterApply = await readSlideOutline(fixture)
    expect(afterApply.ok && afterApply.slides[1]?.title).toBe('New page 2')
    expect(afterApply.ok && afterApply.slides[0]?.title).toBe('Page 1')
  })
})
