// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() } }))

import JSZip from 'jszip'

import { importPluginFrom } from './import'

describe('importPluginFrom', () => {
  let root: string
  let roots: { extensions: string; plugins: string }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'lumii-plugin-import-'))
    roots = {
      extensions: path.join(root, 'extensions'),
      plugins: path.join(root, 'plugins'),
    }
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  async function makeZip(files: Record<string, string>): Promise<string> {
    const zip = new JSZip()
    for (const [name, content] of Object.entries(files)) zip.file(name, content)
    const out = path.join(root, 'plugin.zip')
    writeFileSync(out, await zip.generateAsync({ type: 'nodebuffer' }))
    return out
  }

  it('压缩包外套一层目录 → 自动剥掉，按 plugin.json 的 id 落进 plugins', async () => {
    const zipPath = await makeZip({
      'my-plugin/plugin.json': JSON.stringify({ id: 'my-plugin', name: '示例', version: '0.1.0' }),
      'my-plugin/client.js': '// client',
    })

    const result = await importPluginFrom(zipPath, 'zip', roots)

    expect(result).toMatchObject({ ok: true, id: 'my-plugin', kind: 'client' })
    if (!result.ok) return
    expect(result.dir).toBe(path.join(roots.plugins, 'my-plugin'))
  })

  it('含 main.js → 落到 extensions（带 client.js 时为 both）', async () => {
    const zipPath = await makeZip({
      'demo/main.js': 'export default {}',
      'demo/client.js': '// client',
      'demo/plugin.json': JSON.stringify({ id: 'demo' }),
    })

    const result = await importPluginFrom(zipPath, 'zip', roots)

    expect(result).toMatchObject({ ok: true, id: 'demo', kind: 'both' })
    if (!result.ok) return
    expect(result.dir).toBe(path.join(roots.extensions, 'demo'))
  })

  it('没有 main.js / client.js → 拒绝', async () => {
    const zipPath = await makeZip({ 'demo/readme.md': '# nope' })

    expect(await importPluginFrom(zipPath, 'zip', roots)).toMatchObject({
      ok: false,
      error: expect.stringContaining('main.js 或 client.js'),
    })
  })

  it('同名目录已存在 → 拒绝，不覆盖', async () => {
    const zipPath = await makeZip({ 'dup/client.js': '// v2' })
    mkdirSync(path.join(roots.plugins, 'dup'), { recursive: true })

    const result = await importPluginFrom(zipPath, 'zip', roots)

    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('已存在') })
  })

  it('文件夹导入：排除 node_modules 与 .git', async () => {
    const src = path.join(root, 'src-plugin')
    mkdirSync(path.join(src, 'node_modules', 'x'), { recursive: true })
    mkdirSync(path.join(src, '.git'), { recursive: true })
    writeFileSync(path.join(src, 'client.js'), '// client')
    writeFileSync(path.join(src, 'plugin.json'), JSON.stringify({ id: 'folder-demo' }))

    const result = await importPluginFrom(src, 'folder', roots)

    expect(result).toMatchObject({ ok: true, id: 'folder-demo', kind: 'client' })
    if (!result.ok) return
    const { existsSync } = await import('node:fs')
    expect(existsSync(path.join(result.dir, 'node_modules'))).toBe(false)
    expect(existsSync(path.join(result.dir, '.git'))).toBe(false)
    expect(existsSync(path.join(result.dir, 'client.js'))).toBe(true)
  })

  it('路径名会净化成安全目录名', async () => {
    const sourceDir = path.join(root, 'weird name!')
    mkdirSync(sourceDir, { recursive: true })
    // 用目录名带空格与标点的文件夹导入，验证净化
    writeFileSync(path.join(sourceDir, 'client.js'), '// client')

    const result = await importPluginFrom(sourceDir, 'folder', roots)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(path.basename(result.dir)).toBe('weird-name')
  })
})
