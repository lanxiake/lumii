/**
 * 插件预安装默认环境配置单测
 *
 * MemPalace 于 2026-09-18 整体移除（记忆宫殿换成本地 SQLite 自研实现，
 * 不再需要 Python 运行时与远端下载），因此这里只剩 CloakBrowser 一项。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyPluginBootstrapEnvDefaults,
  DEFAULT_LUMII_CLOAK_BROWSER_BOOTSTRAP,
  isCloakBrowserBootstrapEnabled,
} from './plugin-bootstrap-config'

describe('applyPluginBootstrapEnvDefaults', () => {
  const keys = ['LUMII_CLOAK_BROWSER_BOOTSTRAP', 'LUMII_SKIP_PLUGIN_BOOTSTRAP'] as const
  const snapshot: Partial<Record<(typeof keys)[number], string | undefined>> = {}

  afterEach(() => {
    for (const key of keys) {
      if (snapshot[key] === undefined) delete process.env[key]
      else process.env[key] = snapshot[key]
    }
  })

  function saveEnv(): void {
    for (const key of keys) snapshot[key] = process.env[key]
  }

  it('未配置时默认启用预安装', () => {
    saveEnv()
    delete process.env.LUMII_CLOAK_BROWSER_BOOTSTRAP
    delete process.env.LUMII_SKIP_PLUGIN_BOOTSTRAP
    applyPluginBootstrapEnvDefaults()
    expect(process.env.LUMII_CLOAK_BROWSER_BOOTSTRAP).toBe(DEFAULT_LUMII_CLOAK_BROWSER_BOOTSTRAP)
    expect(isCloakBrowserBootstrapEnabled()).toBe(true)
  })

  it('LUMII_SKIP_PLUGIN_BOOTSTRAP=1 时跳过', () => {
    saveEnv()
    process.env.LUMII_SKIP_PLUGIN_BOOTSTRAP = '1'
    expect(isCloakBrowserBootstrapEnabled()).toBe(false)
  })

  it('单项设为 0 时关闭该预安装', () => {
    saveEnv()
    process.env.LUMII_CLOAK_BROWSER_BOOTSTRAP = '0'
    expect(isCloakBrowserBootstrapEnabled()).toBe(false)
  })
})
