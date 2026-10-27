// @vitest-environment node
/**
 * 版本对照分派（P2 T6）：文本逐行、图片并排物化、PPT 页级文本对照。
 * 真文件系统 + 真 OOXML（jszip 造最小 pptx）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import JSZip from 'jszip'
import type { LocalArtifactEdit } from '../shared/artifact-edit-types'
import type { ArtifactVersionInfo } from '../shared/artifact-version-types'
import { compareVersionPair } from './artifact-version-compare'

let base = ''
let root = ''

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), 'lumii-compare-'))
  root = path.join(base, 'ws')
  await mkdir(root, { recursive: true })
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

async function writeAt(rel: string, content: string | Buffer): Promise<void> {
  const abs = path.join(root, ...rel.split('/'))
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, content)
}

async function writeEdit(editId: string, relPath: string, content: Buffer): Promise<void> {
  const dir = path.join(root, '.lumii', 'edits', editId)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      editId,
      sessionKey: 'conv-1',
      path: relPath,
      action: 'manual',
      scope: { type: 'file' },
      at: Date.now(),
      status: 'applied',
      baseHash: 'x',
      candidateFile: 'candidate.bin',
      beforeFile: 'before.bin',
      originalBytes: 0,
    }),
  )
  await writeFile(path.join(dir, 'candidate.bin'), content)
}

function versionInfo(overrides: Partial<ArtifactVersionInfo>): ArtifactVersionInfo {
  return {
    versionId: 'turn:m1',
    source: 'turn',
    turnId: 'm1',
    timestamp: 2000,
    status: 'modified',
    content: { available: true, kind: 'store' },
    ...overrides,
  }
}

function localEdit(editId: string, relPath: string): LocalArtifactEdit {
  return {
    editId,
    sessionKey: 'conv-1',
    path: relPath,
    action: 'manual',
    scope: { type: 'file' },
    at: 1000,
    bytes: 1,
  }
}

function slideXml(title: string, lines: string[]): string {
  const paras = [title, ...lines]
    .map((text) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody>${paras}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`
}

async function makePptx(slides: Array<[string, string[]]>): Promise<Buffer> {
  const zip = new JSZip()
  slides.forEach(([title, lines], index) => {
    zip.file(`ppt/slides/slide${index + 1}.xml`, slideXml(title, lines))
  })
  return zip.generateAsync({ type: 'nodebuffer' })
}

describe('compareVersionPair', () => {
  it('文本：逐行 diff（kind=text）', async () => {
    const FILE = 'outputs/x/doc.md'
    await writeAt(FILE, '# t\n\nNEW line\n')
    await writeEdit('edit-old', FILE, Buffer.from('# t\n\nOLD line\n'))
    const older = versionInfo({
      versionId: 'local:edit-old',
      source: 'local',
      turnId: undefined,
      timestamp: 1000,
      status: 'edited',
    })
    const current = versionInfo({})
    const result = await compareVersionPair({
      workspaceDir: root,
      path: FILE,
      from: older,
      to: current,
      allVersions: [older, current],
      localEdits: [localEdit('edit-old', FILE)],
      fromLabel: '本地 10:00',
      toLabel: 'Agent 10:05',
    })
    expect(result.ok).toBe(true)
    if (!result.ok || result.kind !== 'text') return
    expect(result.insertions).toBe(1)
    expect(result.deletions).toBe(1)
    expect(result.hunks[0]?.lines.join('\n')).toContain('+NEW line')
  })

  it('图片：两版都物化成副本，返回并排用的路径', async () => {
    const PIC = 'outputs/x/cover.png'
    await writeAt(PIC, 'NEW-IMAGE')
    await writeEdit('edit-old', PIC, Buffer.from('OLD-IMAGE'))
    const older = versionInfo({
      versionId: 'local:edit-old',
      source: 'local',
      turnId: undefined,
      timestamp: 1000,
      status: 'edited',
    })
    const current = versionInfo({})
    const result = await compareVersionPair({
      workspaceDir: root,
      path: PIC,
      from: older,
      to: current,
      allVersions: [older, current],
      localEdits: [localEdit('edit-old', PIC)],
      fromLabel: '本地 10:00',
      toLabel: 'Agent 10:05',
    })
    expect(result.ok).toBe(true)
    if (!result.ok || result.kind !== 'image') return
    expect(result.from.label).toBe('本地 10:00')
    expect(result.from.path.startsWith('.lumii/exports/versions/')).toBe(true)
    expect(await readFile(path.join(root, ...result.from.path.split('/')), 'utf8')).toBe('OLD-IMAGE')
    expect(await readFile(path.join(root, ...result.to.path.split('/')), 'utf8')).toBe('NEW-IMAGE')
  })

  it('PPT：页级文本对照，只列出有变化的页', async () => {
    const DECK = 'outputs/x/deck.pptx'
    const oldDeck = await makePptx([
      ['封面', ['副标题']],
      ['第二页', ['旧要点 A', '旧要点 B']],
      ['第三页', ['不变']],
    ])
    const newDeck = await makePptx([
      ['封面', ['副标题']],
      ['第二页', ['新要点 A']],
      ['第三页', ['不变']],
    ])
    await writeAt(DECK, newDeck)
    await writeEdit('edit-deck', DECK, oldDeck)
    const older = versionInfo({
      versionId: 'local:edit-deck',
      source: 'local',
      turnId: undefined,
      timestamp: 1000,
      status: 'edited',
    })
    const current = versionInfo({})
    const result = await compareVersionPair({
      workspaceDir: root,
      path: DECK,
      from: older,
      to: current,
      allVersions: [older, current],
      localEdits: [localEdit('edit-deck', DECK)],
      fromLabel: '本地 10:00',
      toLabel: 'Agent 10:05',
    })
    expect(result.ok).toBe(true)
    if (!result.ok || result.kind !== 'slides') return
    expect(result.totalPages).toBe(3)
    expect(result.pages.map((page) => page.index)).toEqual([1])
    expect(result.pages[0]?.title).toBe('第二页')
    expect(result.pages[0]?.insertions).toBe(1)
    expect(result.pages[0]?.deletions).toBe(2)
  })

  it('二进制旧版没有副本时给可读原因', async () => {
    const PIC = 'outputs/x/old.png'
    await writeAt(PIC, 'CURRENT')
    const older = versionInfo({ versionId: 'turn:m0', turnId: 'm0', timestamp: 1000 })
    const current = versionInfo({})
    const result = await compareVersionPair({
      workspaceDir: root,
      path: PIC,
      from: older,
      to: current,
      allVersions: [older, current],
      fromLabel: 'a',
      toLabel: 'b',
    })
    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.reason).toContain('二进制')
  })
})
