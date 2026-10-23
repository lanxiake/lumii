// @vitest-environment node
// 必须用 node 环境：本文件要动态 import 真实文件，jsdom 下这条路径走不通。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { PluginHost } from '@mtbot/plugin-core'

import type { MainEvents } from '../../main/kernel/events'
import {
  discoverExternalExtensions,
  ExternalExtensionRuntime,
  parseExternalModule,
} from './loader'

const silentLog = { info: () => {}, warn: () => {}, error: () => {} }

/** 外部扩展模块写成真实文件，走动态 import 的同一条路径。 */
function writeExtension(root: string, dirName: string, marker: string, id = 'com.test.ext'): string {
  const dir = path.join(root, dirName)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'main.js')
  writeFileSync(
    file,
    `export default {
  manifest: {
    id: ${JSON.stringify(id)},
    name: '测试扩展',
    version: '0.1.0',
    engines: { lumii: '>=0.1.0' },
    kind: 'code',
    main: './main.js',
  },
  definition: {
    id: ${JSON.stringify(id)},
    apply(ctx) {
      globalThis.__extMarkers = globalThis.__extMarkers || []
      globalThis.__extMarkers.push(${JSON.stringify(marker)})
      ctx.effect(() => {
        globalThis.__extDisposed = globalThis.__extDisposed || []
        globalThis.__extDisposed.push(${JSON.stringify(marker)})
      })
    },
  },
}
`,
  )
  return dir
}

/** manifest 合法、但 apply 会抛错的扩展：用于测「失败后不再每秒重试」。 */
function writeThrowingExtension(root: string, dirName: string, id = 'com.test.ext'): void {
  const dir = path.join(root, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, 'main.js'),
    `export default {
  manifest: {
    id: ${JSON.stringify(id)},
    name: '会炸的扩展',
    version: '0.1.0',
    engines: { lumii: '>=0.1.0' },
    kind: 'code',
    main: './main.js',
  },
  definition: {
    id: ${JSON.stringify(id)},
    apply() {
      globalThis.__extMarkers = globalThis.__extMarkers || []
      globalThis.__extMarkers.push('boom')
      throw new Error('apply 故意炸')
    },
  },
}
`,
  )
}

function markers(): string[] {
  return (globalThis as unknown as { __extMarkers?: string[] }).__extMarkers ?? []
}

function disposed(): string[] {
  return (globalThis as unknown as { __extDisposed?: string[] }).__extDisposed ?? []
}

function resetGlobals(): void {
  delete (globalThis as unknown as { __extMarkers?: string[] }).__extMarkers
  delete (globalThis as unknown as { __extDisposed?: string[] }).__extDisposed
}

describe('discoverExternalExtensions', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'lumii-ext-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('目录不存在时返回空数组而不是抛错', () => {
    expect(discoverExternalExtensions(path.join(root, 'nope'))).toEqual([])
  })

  it('只收含 main.js 的子目录', () => {
    writeExtension(root, 'has-entry', 'a')
    mkdirSync(path.join(root, 'no-entry'))
    writeFileSync(path.join(root, 'loose-file.js'), '')

    const found = discoverExternalExtensions(root)

    expect(found).toHaveLength(1)
    expect(path.basename(found[0].dir)).toBe('has-entry')
  })
})

describe('parseExternalModule', () => {
  it('接受 default 导出', () => {
    const mod = parseExternalModule({
      default: {
        manifest: { id: 'com.a.b', name: 'x', version: '0.1.0', engines: { lumii: '>=0.1.0' }, kind: 'code', main: './main.js' },
        definition: { id: 'com.a.b', apply() {} },
      },
    })

    expect(mod.manifest.id).toBe('com.a.b')
  })

  it('接受具名导出', () => {
    const mod = parseExternalModule({
      manifest: { id: 'com.a.b', name: 'x', version: '0.1.0', engines: { lumii: '>=0.1.0' }, kind: 'code', main: './main.js' },
      definition: { id: 'com.a.b', apply() {} },
    })

    expect(mod.definition.id).toBe('com.a.b')
  })

  it('缺 definition 抛错', () => {
    expect(() => parseExternalModule({ manifest: { id: 'com.a.b' } })).toThrow(/缺少 definition/)
  })

  it('definition.apply 不是函数抛错', () => {
    expect(() =>
      parseExternalModule({
        manifest: { id: 'com.a.b' },
        definition: { id: 'com.a.b', apply: 'nope' },
      }),
    ).toThrow(/apply 必须是函数/)
  })

  it('两个 id 不一致时拒绝（否则注册与记账会错位）', () => {
    expect(() =>
      parseExternalModule({
        manifest: { id: 'com.a.b', name: 'x', version: '0.1.0', engines: { lumii: '>=0.1.0' }, kind: 'code', main: './main.js' },
        definition: { id: 'com.a.other', apply() {} },
      }),
    ).toThrow(/不一致/)
  })

  it('manifest 结构非法时由 validateManifest 拒绝', () => {
    expect(() =>
      parseExternalModule({
        manifest: { id: 'x' },
        definition: { id: 'x', apply() {} },
      }),
    ).toThrow(/manifest 校验失败/)
  })
})

describe('ExternalExtensionRuntime', () => {
  let root: string
  let host: PluginHost<MainEvents>

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'lumii-ext-rt-'))
    host = new PluginHost<MainEvents>()
    resetGlobals()
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    resetGlobals()
  })

  it('加载 → 重扫跳过未变 → 改文件重载 → 删目录卸载', async () => {
    writeExtension(root, 'ext-a', 'v1')
    const runtime = new ExternalExtensionRuntime(host, silentLog, { root })

    await runtime.loadAll()
    expect(markers()).toEqual(['v1'])
    expect(host.get('com.test.ext')?.state).toBe('active')

    // 未改动：不重复激活
    await runtime.rescan()
    expect(markers()).toEqual(['v1'])

    // 改内容（同时改长度，保证 revision 变化）
    writeExtension(root, 'ext-a', 'v2-longer')
    await runtime.rescan()
    expect(markers()).toEqual(['v1', 'v2-longer'])
    expect(disposed()).toEqual(['v1']) // 旧作用域先被销毁

    // 删目录：卸载
    rmSync(path.join(root, 'ext-a'), { recursive: true, force: true })
    await runtime.rescan()
    expect(host.get('com.test.ext')).toBeUndefined()
    expect(disposed()).toEqual(['v1', 'v2-longer'])
  })

  it('新版本语法坏掉时保留旧版本（真回滚）', async () => {
    writeExtension(root, 'ext-a', 'v1')
    const runtime = new ExternalExtensionRuntime(host, silentLog, { root })
    await runtime.loadAll()

    // 写一个语法错误的版本
    writeFileSync(path.join(root, 'ext-a', 'main.js'), 'export default { this is not valid js')

    await runtime.rescan()

    // 旧版本仍在服务：没被卸载，也没被替换
    expect(host.get('com.test.ext')?.state).toBe('active')
    expect(disposed()).toEqual([])
  })

  it('与已注册扩展撞 id 时跳过，不动已有扩展', async () => {
    host.register({ id: 'com.test.ext', apply() {} })
    await host.activate('com.test.ext')

    writeExtension(root, 'ext-a', 'v1')
    const runtime = new ExternalExtensionRuntime(host, silentLog, { root })
    await runtime.loadAll()

    expect(markers()).toEqual([]) // 没被外部版本覆盖
    expect(host.get('com.test.ext')?.state).toBe('active')
  })

  it('激活失败（apply 抛错）后，同一 revision 重扫不会反复重试', async () => {
    writeThrowingExtension(root, 'ext-bad')
    const runtime = new ExternalExtensionRuntime(host, silentLog, { root })

    await runtime.loadAll()
    expect(markers()).toEqual(['boom'])
    expect(runtime.inspect()[0]?.error).toContain('apply 故意炸')

    // 文件没变 → 不该再导入/激活（否则日志每秒刷一条、宿主每秒 register/unregister）
    await runtime.rescan()
    await runtime.rescan()
    expect(markers()).toEqual(['boom'])
  })

  it('新版本 apply 抛错时回滚旧版，之后也不再每秒重试', async () => {
    writeExtension(root, 'ext-a', 'v1')
    const runtime = new ExternalExtensionRuntime(host, silentLog, { root })
    await runtime.loadAll()

    writeThrowingExtension(root, 'ext-a')
    await runtime.rescan()

    // v1 → 新版本炸 → 回滚把 v1 重新挂起来
    expect(markers()).toEqual(['v1', 'boom', 'v1'])
    expect(host.get('com.test.ext')?.state).toBe('active')

    await runtime.rescan()
    await runtime.rescan()
    expect(markers()).toEqual(['v1', 'boom', 'v1'])
    expect(runtime.inspect()[0]?.enabled).toBe(true)
  })

  it('禁用态启动只登记不注册；运行期启用补 register+activate，停用拆作用域', async () => {
    writeExtension(root, 'ext-a', 'v1')
    const runtime = new ExternalExtensionRuntime(host, silentLog, {
      root,
      disabledIds: new Set(['com.test.ext']),
    })
    await runtime.loadAll()

    // 没注册进宿主：列表里看得见，但拿不到 handler
    expect(markers()).toEqual([])
    expect(host.get('com.test.ext')).toBeUndefined()
    expect(runtime.inspect()[0]).toMatchObject({ enabled: false, state: 'disabled' })

    expect(await runtime.setEnabled('com.test.ext', true)).toEqual({ ok: true })
    expect(markers()).toEqual(['v1'])
    expect(host.get('com.test.ext')?.state).toBe('active')

    expect(await runtime.setEnabled('com.test.ext', false)).toEqual({ ok: true })
    expect(disposed()).toEqual(['v1'])
    expect(runtime.inspect()[0]).toMatchObject({ enabled: false, state: 'disabled' })

    // 禁用期间改文件：rescan 不得把它又激活回去
    writeExtension(root, 'ext-a', 'v2-longer')
    await runtime.rescan()
    expect(markers()).toEqual(['v1'])

    // 再启用拿到的是新版本
    expect(await runtime.setEnabled('com.test.ext', true)).toEqual({ ok: true })
    expect(markers()).toEqual(['v1', 'v2-longer'])
  })
})
