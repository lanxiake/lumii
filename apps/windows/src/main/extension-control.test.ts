import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PluginHost } from '@mtbot/plugin-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createExtensionControl } from './extension-control'
import type { ExternalExtensionRuntime } from './extension-loader'
import type { MainEvents } from './kernel/events'
import { readExtensionPrefs } from './kernel/extension-store'
import type { BuiltinExtension } from './plugin-host'

/**
 * 用假清单而不是 BUILTIN_EXTENSIONS：真实清单会把 voice / onnx 整条依赖链
 * import 进单测进程（那正是把 builtins 做成可注入依赖的原因）。
 */
const builtins: BuiltinExtension[] = [
  {
    manifest: {
      id: 'com.test.alpha',
      name: 'Alpha',
      version: '1.0.0',
      engines: { lumii: '>=0.1.0' },
      kind: 'code',
      requires: { assets: ['ffmpeg'], optional: true },
    },
    definition: { id: 'com.test.alpha', apply() {} },
  },
]

/** 只实现控制面用到的方法 */
function fakeExternal(
  entries: Array<{ id: string; enabled: boolean }>,
  disabledAtStartup: string[] = [],
): ExternalExtensionRuntime {
  return {
    inspect: () =>
      entries.map((e) => ({
        dir: e.id,
        id: e.id,
        name: e.id,
        version: '0.0.1',
        enabled: e.enabled,
        state: e.enabled ? 'active' : 'disabled',
      })),
    startupDisabledIds: () => new Set(disabledAtStartup),
    dirOf: (id: string) =>
      entries.some((e) => e.id === id) ? path.join('C:/fake-ext', id) : null,
    remove: async (id: string) =>
      entries.some((e) => e.id === id)
        ? { ok: true as const, dir: path.join('C:/fake-ext', id) }
        : { ok: false as const, error: `找不到 ${id}` },
  } as unknown as ExternalExtensionRuntime
}

describe('createExtensionControl', () => {
  let dir: string
  let storeFile: string
  let host: PluginHost<MainEvents>

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'lumii-ext-control-'))
    storeFile = path.join(dir, 'extensions.json')
    host = new PluginHost<MainEvents>()
    host.register(builtins[0].definition)
    await host.activate('com.test.alpha')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('合并内置与外部扩展，并带上宿主里的真实状态', () => {
    const control = createExtensionControl({
      host,
      builtins,
      external: fakeExternal([{ id: 'com.test.ext', enabled: true }]),
      storeFile,
    })

    const list = control.list()

    expect(list.map((x) => x.id)).toEqual(['com.test.alpha', 'com.test.ext'])
    expect(list[0]).toMatchObject({
      kind: 'builtin',
      enabled: true,
      state: 'active',
      pendingRestart: false,
      requires: { assets: ['ffmpeg'], optional: true },
    })
    expect(list[1]).toMatchObject({ kind: 'external', enabled: true, state: 'active', pendingRestart: false })
  })

  it('官方清单里未安装的扩展 → 可安装行（不与已加载条目重复）', () => {
    const control = createExtensionControl({
      host,
      builtins,
      external: fakeExternal([{ id: 'com.test.ext', enabled: true }]),
      storeFile,
      officialCatalog: [
        { id: 'com.test.ext', name: '已装的', description: '', version: '1', asset: 'a.js', sha256: 'x' },
        { id: 'com.test.optional', name: '可选', description: '按需下载', version: '0.1.0', asset: 'b.js', sha256: 'y' },
      ],
    })

    const list = control.list()
    expect(list.filter((x) => x.id === 'com.test.ext')).toHaveLength(1)
    expect(list.find((x) => x.id === 'com.test.ext')).toMatchObject({ state: 'active' })
    expect(list.find((x) => x.id === 'com.test.optional')).toMatchObject({
      state: 'available',
      installable: true,
      origin: 'official',
      description: '按需下载',
      enabled: false,
    })
  })

  it('官方扩展已装的 sha256 与清单不同 → updatable；相同则不标', () => {
    const extDir = path.join(dir, 'exts', 'com.test.official')
    mkdirSync(extDir, { recursive: true })
    writeFileSync(
      path.join(extDir, '.official.json'),
      JSON.stringify({ id: 'com.test.official', sha256: 'old-sha' }),
      'utf8',
    )
    const external = {
      inspect: () => [
        {
          dir: extDir,
          id: 'com.test.official',
          name: '官方',
          version: '0.1.0',
          origin: 'official',
          enabled: true,
          state: 'active',
        },
      ],
      startupDisabledIds: () => new Set<string>(),
      dirOf: () => extDir,
      remove: async () => ({ ok: true as const, dir: extDir }),
    } as unknown as ExternalExtensionRuntime
    const officialCatalog = [
      {
        id: 'com.test.official',
        name: '官方',
        description: '',
        version: '0.1.0',
        asset: 'a.js',
        sha256: 'new-sha',
      },
    ]

    const control = createExtensionControl({ host, builtins, external, storeFile, officialCatalog })
    expect(control.list().find((x) => x.id === 'com.test.official')).toMatchObject({
      origin: 'official',
      updatable: true,
    })

    writeFileSync(
      path.join(extDir, '.official.json'),
      JSON.stringify({ id: 'com.test.official', sha256: 'new-sha' }),
      'utf8',
    )
    expect(
      createExtensionControl({ host, builtins, external, storeFile, officialCatalog }).list()
        .find((x) => x.id === 'com.test.official')?.updatable,
    ).toBeUndefined()
  })

  it('内置扩展：改完开关到重启前 pendingRestart=true', () => {
    const control = createExtensionControl({ host, builtins, storeFile })

    control.setEnabled('com.test.alpha', false)

    expect(control.list()[0]).toMatchObject({ enabled: false, pendingRestart: true })
  })

  it('外部扩展：按启动快照判断待重启，而不是按运行时 enabled', () => {
    // 启动时被禁用、偏好里现在没禁用 → 已启用但还没重启
    const control = createExtensionControl({
      host,
      builtins,
      storeFile,
      external: fakeExternal([{ id: 'com.test.ext', enabled: false }], ['com.test.ext']),
    })

    expect(control.list()[1]).toMatchObject({ enabled: true, pendingRestart: true })
  })

  it('被禁用的内置扩展：enabled=false、state=disabled', () => {
    const control = createExtensionControl({ host, builtins, storeFile })
    expect(control.setEnabled('com.test.alpha', false)).toEqual({ ok: true, restartRequired: true })

    expect(control.list()[0]).toMatchObject({ enabled: false, state: 'disabled' })
    expect([...readExtensionPrefs(storeFile).disabled]).toEqual(['com.test.alpha'])
  })

  it('未知 id 不写盘', () => {
    const control = createExtensionControl({ host, builtins, storeFile })

    expect(control.setEnabled('nope', false)).toMatchObject({ ok: false })

    expect(readExtensionPrefs(storeFile).disabled.size).toBe(0)
  })

  it('内置扩展不能删除，只能禁用', async () => {
    const control = createExtensionControl({ host, builtins, storeFile })

    const result = await control.remove({ kind: 'builtin', id: 'com.test.alpha' })

    expect(result).toMatchObject({ ok: false })
    expect(control.dirOf({ kind: 'builtin', id: 'com.test.alpha' })).toBeNull()
  })

  it('删除外部扩展：删目录并清掉禁用记录', async () => {
    const control = createExtensionControl({
      host,
      builtins,
      storeFile,
      external: fakeExternal([{ id: 'com.test.ext', enabled: true }]),
    })
    control.setEnabled('com.test.ext', false)
    expect(readExtensionPrefs(storeFile).disabled.size).toBe(1)

    const result = await control.remove({ kind: 'external', id: 'com.test.ext' })

    expect(result).toMatchObject({ ok: true })
    expect(readExtensionPrefs(storeFile).disabled.size).toBe(0)
  })

  it('删除客户端插件：删目录并清掉 disabledClient', async () => {
    const clientRoot = path.join(dir, 'plugins')
    mkdirSync(path.join(clientRoot, 'demo'), { recursive: true })
    writeFileSync(path.join(clientRoot, 'demo', 'client.js'), '', 'utf8')
    const control = createExtensionControl({
      host,
      builtins,
      storeFile,
      clientPluginsRoot: clientRoot,
    })
    control.setClientEnabled('demo', false)

    const result = await control.remove({ kind: 'client', id: 'demo', dir: 'demo' })

    expect(result).toMatchObject({ ok: true })
    expect(existsSync(path.join(clientRoot, 'demo'))).toBe(false)
    expect(readExtensionPrefs(storeFile).disabledClient.size).toBe(0)
  })

  it('客户端目录名拒绝路径穿越', async () => {
    const clientRoot = path.join(dir, 'plugins-safe')
    mkdirSync(clientRoot, { recursive: true })
    const control = createExtensionControl({
      host,
      builtins,
      storeFile,
      clientPluginsRoot: clientRoot,
    })

    expect(control.dirOf({ kind: 'client', id: '..', dir: '..' })).toBeNull()
    expect(await control.remove({ kind: 'client', id: '..', dir: '..' })).toMatchObject({ ok: false })
  })

  it('客户端插件开关写到 disabledClient，不碰主进程集合', () => {
    const control = createExtensionControl({ host, builtins, storeFile })

    expect(control.setClientEnabled('demo-card', false)).toEqual({ ok: true })

    const prefs = readExtensionPrefs(storeFile)
    expect([...prefs.disabledClient]).toEqual(['demo-card'])
    expect(prefs.disabled.size).toBe(0)
  })
})
