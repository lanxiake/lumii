import { mkdtempSync, rmSync } from 'node:fs'
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
    },
    definition: { id: 'com.test.alpha', apply() {} },
  },
]

/** 只实现控制面用到的那一个方法 */
function fakeExternal(entries: Array<{ id: string; enabled: boolean }>): ExternalExtensionRuntime {
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
    expect(list[0]).toMatchObject({ kind: 'builtin', enabled: true, state: 'active' })
    expect(list[1]).toMatchObject({ kind: 'external', enabled: true, state: 'active' })
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

  it('客户端插件开关写到 disabledClient，不碰主进程集合', () => {
    const control = createExtensionControl({ host, builtins, storeFile })

    expect(control.setClientEnabled('demo-card', false)).toEqual({ ok: true })

    const prefs = readExtensionPrefs(storeFile)
    expect([...prefs.disabledClient]).toEqual(['demo-card'])
    expect(prefs.disabled.size).toBe(0)
  })
})
