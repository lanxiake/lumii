// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseClientPluginMeta } from './client-plugin-meta'
import { discoverClientPlugins } from './client-plugin-discovery'

function writePlugin(root: string, dirName: string, meta?: object): string {
  const dir = path.join(root, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'client.js'), '// probe', 'utf8')
  if (meta) writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(meta), 'utf8')
  return dir
}

describe('parseClientPluginMeta', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'lumii-client-meta-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('没有 plugin.json：按目录名登记，视为兼容', () => {
    const dir = writePlugin(root, 'plain')

    expect(parseClientPluginMeta(dir, 'plain')).toMatchObject({
      id: 'plain',
      name: 'plain',
      origin: 'user',
      compatible: true,
    })
  })

  it('完整清单：来源、描述、engines 都读出来', () => {
    const dir = writePlugin(root, 'good', {
      id: 'good',
      name: '好插件',
      version: '0.2.0',
      description: '说明',
      author: 'agent',
      origin: 'agent',
      engines: { lumii: '>=0.1.0' },
    })

    expect(parseClientPluginMeta(dir, 'good', { appVersion: '0.1.5' })).toMatchObject({
      id: 'good',
      version: '0.2.0',
      description: '说明',
      origin: 'agent',
      compatible: true,
    })
  })

  it('engines 不满足当前客户端：compatible=false，原因单独给出', () => {
    const dir = writePlugin(root, 'future', {
      id: 'future',
      name: '未来插件',
      version: '1.0.0',
      engines: { lumii: '>=99.0.0' },
    })

    const meta = parseClientPluginMeta(dir, 'future', { appVersion: '0.1.5' })
    expect(meta.compatible).toBe(false)
    expect(meta.incompatibleReason).toMatch(/99\.0\.0/)
    expect(meta.manifestError).toBeUndefined()
  })

  it('缺失 engines 视为任意版本', () => {
    const dir = writePlugin(root, 'noengines', { id: 'noengines', version: '0.1.0' })

    expect(parseClientPluginMeta(dir, 'noengines', { appVersion: '0.1.5' }).compatible).toBe(true)
  })

  it('坏 JSON / 非法 origin / 非法 id：manifestError 而非静默忽略', () => {
    const badJson = path.join(root, 'badjson')
    mkdirSync(badJson)
    writeFileSync(path.join(badJson, 'plugin.json'), '{not json', 'utf8')
    expect(parseClientPluginMeta(badJson, 'badjson').manifestError).toMatch(/JSON/)

    const badOrigin = writePlugin(root, 'badorigin', { id: 'badorigin', origin: 'robot' })
    expect(parseClientPluginMeta(badOrigin, 'badorigin').manifestError).toMatch(/origin/)

    // 客户端 id 允许单段（目录名），但拒绝空格/大写/路径分隔符
    const simpleId = writePlugin(root, 'simple', { id: 'foo' })
    expect(parseClientPluginMeta(simpleId, 'simple').manifestError).toBeUndefined()

    const badId = writePlugin(root, 'badid', { id: 'Bad Id' })
    expect(parseClientPluginMeta(badId, 'badid').manifestError).toMatch(/id 只能包含/)
  })
})

describe('discoverClientPlugins', () => {
  let root: string
  let storeFile: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'lumii-client-discover-'))
    storeFile = path.join(root, 'extensions.json')
    writeFileSync(storeFile, JSON.stringify({ version: 2, disabled: [], disabledClient: [] }), 'utf8')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('清单元数据透传给渲染层；禁用表与版本不兼容各自生效', () => {
    writePlugin(root, 'agent-made', {
      id: 'agent-made',
      name: 'Agent 作品',
      version: '0.1.0',
      origin: 'agent',
      engines: { lumii: '>=0.1.0' },
    })
    writePlugin(root, 'too-new', {
      id: 'too-new',
      version: '0.1.0',
      engines: { lumii: '>=99.0.0' },
    })
    writeFileSync(
      storeFile,
      JSON.stringify({ version: 2, disabled: [], disabledClient: ['agent-made'] }),
      'utf8',
    )

    const list = discoverClientPlugins({
      root,
      storeFile,
      appVersion: '0.1.5',
    })

    expect(list.map((p) => p.id)).toEqual(['agent-made', 'too-new'])
    expect(list[0]).toMatchObject({ origin: 'agent', enabled: false, compatible: true })
    expect(list[1]).toMatchObject({ enabled: true, compatible: false })
    expect(list[1]?.incompatibleReason).toMatch(/99\.0\.0/)
  })
})
