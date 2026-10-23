import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { discoverClientPlugins } from './client-plugin-discovery'

/**
 * 两个根：`~/.lumii/plugins`（只有渲染层半边）与 `~/.lumii/extensions`（前后端一体）。
 * 判据：同一份清单里都能列出来，且启停判据跟来源走。
 */
describe('discoverClientPlugins（多根）', () => {
  let base: string
  let pluginsRoot: string
  let extensionsRoot: string
  let storeFile: string

  function writePlugin(root: string, dir: string, id: string): void {
    const d = path.join(root, dir)
    mkdirSync(d, { recursive: true })
    writeFileSync(path.join(d, 'client.js'), '// client')
    writeFileSync(
      path.join(d, 'plugin.json'),
      JSON.stringify({ id, name: id, version: '0.1.0', engines: { lumii: '>=0.1.0' } }),
    )
  }

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'lumii-client-plugins-'))
    pluginsRoot = path.join(base, 'plugins')
    extensionsRoot = path.join(base, 'extensions')
    storeFile = path.join(base, 'extensions.json')
    mkdirSync(pluginsRoot, { recursive: true })
    mkdirSync(extensionsRoot, { recursive: true })
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('客户端插件根与扩展根带 client.js 的目录都列出来，并标出来源根', () => {
    writePlugin(pluginsRoot, 'client-only', 'com.test.client')
    writePlugin(extensionsRoot, 'both-halves', 'com.test.both')
    // 扩展根里只有 main.js 的：没有渲染层半边，不该出现在渲染层清单里
    const mainOnly = path.join(extensionsRoot, 'main-only')
    mkdirSync(mainOnly, { recursive: true })
    writeFileSync(path.join(mainOnly, 'main.js'), '// main')

    const list = discoverClientPlugins({
      roots: [
        { kind: 'plugins', dir: pluginsRoot },
        { kind: 'extensions', dir: extensionsRoot },
      ],
      storeFile,
    })

    expect(list.map((p) => [p.id, p.root])).toEqual([
      ['com.test.both', 'extensions'],
      ['com.test.client', 'plugins'],
    ])
  })

  it('启停判据跟来源走：扩展根的开关读主进程那份 disabled', () => {
    writePlugin(pluginsRoot, 'client-only', 'com.test.client')
    writePlugin(extensionsRoot, 'both-halves', 'com.test.both')
    writeFileSync(
      storeFile,
      JSON.stringify({ disabled: ['com.test.both'], disabledClient: ['com.test.client'] }),
    )

    const list = discoverClientPlugins({
      roots: [
        { kind: 'plugins', dir: pluginsRoot },
        { kind: 'extensions', dir: extensionsRoot },
      ],
      storeFile,
    })

    expect(list.every((p) => p.enabled === false)).toBe(true)
  })
})
