// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  installOfficialExtension,
  isOfficialExtensionInstalled,
  loadOfficialCatalog,
  removeOfficialExtension,
  syncOfficialExtensions,
  type OfficialCatalogEntry,
} from './official-extensions'

const ENTRY: OfficialCatalogEntry = {
  id: 'com.test.ext',
  name: '测试扩展',
  description: '按需下载用',
  version: '0.2.0',
  asset: 'ext-com.test.ext.js',
  sha256: 'abc123',
}

function writeOfficial(root: string, id: string, sha256: string): void {
  const dir = path.join(root, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'main.js'), 'export default {}\n', 'utf8')
  writeFileSync(
    path.join(dir, 'build-info.json'),
    JSON.stringify({ id, version: '0.1.0', sha256 }),
    'utf8',
  )
}

describe('syncOfficialExtensions', () => {
  let base: string
  let src: string
  let dest: string

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'lumii-official-'))
    src = path.join(base, 'resources')
    dest = path.join(base, 'user-extensions')
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  it('首次安装 → 再次同步跳过 → 内容变化后覆盖', () => {
    writeOfficial(src, 'com.test.ext', 'sha-v1')

    expect(syncOfficialExtensions(src, dest).installed).toEqual(['com.test.ext'])
    expect(existsSync(path.join(dest, 'com.test.ext', 'main.js'))).toBe(true)
    expect(JSON.parse(readFileSync(path.join(dest, 'com.test.ext', '.official.json'), 'utf8')).sha256)
      .toBe('sha-v1')

    expect(syncOfficialExtensions(src, dest).skipped).toEqual(['com.test.ext'])

    writeOfficial(src, 'com.test.ext', 'sha-v2')
    expect(syncOfficialExtensions(src, dest).installed).toEqual(['com.test.ext'])
    expect(JSON.parse(readFileSync(path.join(dest, 'com.test.ext', '.official.json'), 'utf8')).sha256)
      .toBe('sha-v2')
  })

  it('目标目录是用户自己的（没有 .official.json）→ 拒绝覆盖并报错', () => {
    writeOfficial(src, 'com.test.ext', 'sha-v1')
    const user = path.join(dest, 'com.test.ext')
    mkdirSync(user, { recursive: true })
    writeFileSync(path.join(user, 'main.js'), '// user code\n', 'utf8')

    const result = syncOfficialExtensions(src, dest)

    expect(result.installed).toEqual([])
    expect(result.errors.join('\n')).toMatch(/拒绝覆盖/)
    expect(readFileSync(path.join(user, 'main.js'), 'utf8')).toBe('// user code\n')
  })

  it('源目录不存在：安静返回空结果（未构建官方扩展）', () => {
    expect(syncOfficialExtensions(path.join(base, 'nope'), dest)).toEqual({
      installed: [],
      skipped: [],
      errors: [],
    })
  })

  it('catalog.json 缺失/损坏：返回空数组（开发模式仍有目录形式）', () => {
    expect(loadOfficialCatalog(src)).toEqual([])
    mkdirSync(src, { recursive: true })
    writeFileSync(path.join(src, 'catalog.json'), '{not json', 'utf8')
    expect(loadOfficialCatalog(src)).toEqual([])
  })

  it('catalog.json 正常：读回清单', () => {
    mkdirSync(src, { recursive: true })
    writeFileSync(
      path.join(src, 'catalog.json'),
      JSON.stringify({ version: 1, extensions: [ENTRY, { id: 'broken' }] }),
      'utf8',
    )
    expect(loadOfficialCatalog(src)).toEqual([ENTRY])
  })

  it('build-info 缺失：记 error，不装一个来历不明的目录', () => {
    const dir = path.join(src, 'broken')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'main.js'), 'export default {}\n', 'utf8')

    const result = syncOfficialExtensions(src, dest)

    expect(result.installed).toEqual([])
    expect(result.errors.join('\n')).toMatch(/build-info/)
    expect(existsSync(path.join(dest, 'broken'))).toBe(false)
  })
})

describe('installOfficialExtension', () => {
  let base: string
  let extensionsDir: string

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'lumii-official-install-'))
    extensionsDir = path.join(base, 'extensions')
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  const downloader = (content: string) => async (destFile: string) => {
    writeFileSync(destFile, content, 'utf8')
  }

  it('下载 → main.js + build-info + marker；报告 done', async () => {
    const phases: string[] = []
    await installOfficialExtension({
      entry: ENTRY,
      extensionsDir,
      download: downloader('export default {}\n'),
      onProgress: (p) => phases.push(p.phase),
    })

    expect(isOfficialExtensionInstalled(extensionsDir, ENTRY.id)).toBe(true)
    expect(readFileSync(path.join(extensionsDir, ENTRY.id, 'main.js'), 'utf8')).toBe('export default {}\n')
    expect(JSON.parse(readFileSync(path.join(extensionsDir, ENTRY.id, 'build-info.json'), 'utf8'))).toMatchObject({
      id: ENTRY.id,
      version: ENTRY.version,
      sha256: ENTRY.sha256,
    })
    expect(JSON.parse(readFileSync(path.join(extensionsDir, ENTRY.id, '.official.json'), 'utf8')).sha256).toBe(
      ENTRY.sha256,
    )
    expect(phases.at(-1)).toBe('done')
    // 下载中的临时文件不能留在根目录（外部加载器只扫子目录，但别攒垃圾）
    expect(existsSync(path.join(extensionsDir, `.staging-${ENTRY.id}.js`))).toBe(false)
  })

  it('目标目录是用户自己的 → 拒绝覆盖，且不发起下载', async () => {
    const userDir = path.join(extensionsDir, ENTRY.id)
    mkdirSync(userDir, { recursive: true })
    writeFileSync(path.join(userDir, 'main.js'), '// user\n', 'utf8')

    let downloaded = false
    await expect(
      installOfficialExtension({
        entry: ENTRY,
        extensionsDir,
        download: async (destFile) => {
          downloaded = true
          writeFileSync(destFile, 'x', 'utf8')
        },
        onProgress: () => {},
      }),
    ).rejects.toThrow(/拒绝覆盖/)
    expect(downloaded).toBe(false)
    expect(readFileSync(path.join(userDir, 'main.js'), 'utf8')).toBe('// user\n')
  })

  it('已装的官方扩展可以覆盖升级', async () => {
    await installOfficialExtension({
      entry: ENTRY,
      extensionsDir,
      download: downloader('v1\n'),
      onProgress: () => {},
    })
    const next = { ...ENTRY, version: '0.3.0', sha256: 'def456', asset: 'ext-com.test.ext.js' }
    await installOfficialExtension({
      entry: next,
      extensionsDir,
      download: downloader('v2\n'),
      onProgress: () => {},
    })

    expect(readFileSync(path.join(extensionsDir, ENTRY.id, 'main.js'), 'utf8')).toBe('v2\n')
    expect(JSON.parse(readFileSync(path.join(extensionsDir, ENTRY.id, '.official.json'), 'utf8')).version).toBe(
      '0.3.0',
    )
  })

  it('卸载只删官方目录；用户目录不动', async () => {
    await installOfficialExtension({
      entry: ENTRY,
      extensionsDir,
      download: downloader('x\n'),
      onProgress: () => {},
    })
    expect(removeOfficialExtension(extensionsDir, ENTRY.id)).toBe(true)
    expect(existsSync(path.join(extensionsDir, ENTRY.id))).toBe(false)

    const userDir = path.join(extensionsDir, 'user.ext')
    mkdirSync(userDir, { recursive: true })
    expect(removeOfficialExtension(extensionsDir, 'user.ext')).toBe(false)
    expect(existsSync(userDir)).toBe(true)
  })
})
