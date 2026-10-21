// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { syncOfficialExtensions } from './official-extensions'

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
