/**
 * 插件预安装默认环境配置单测
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyPluginBootstrapEnvDefaults,
  DEFAULT_LUMII_CLOAK_BROWSER_BOOTSTRAP,
  DEFAULT_LUMII_MEMPALACE_BOOTSTRAP,
  isCloakBrowserBootstrapEnabled,
  isMemPalaceBootstrapEnabled,
} from './plugin-bootstrap-config'

describe('applyPluginBootstrapEnvDefaults', () => {
  const keys = [
    'LUMII_CLOAK_BROWSER_BOOTSTRAP',
    'LUMII_MEMPALACE_BOOTSTRAP',
    'LUMII_SKIP_PLUGIN_BOOTSTRAP',
  ] as const
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

  it('未配置时默认启用两项预安装', () => {
    saveEnv()
    delete process.env.LUMII_CLOAK_BROWSER_BOOTSTRAP
    delete process.env.LUMII_MEMPALACE_BOOTSTRAP
    delete process.env.LUMII_SKIP_PLUGIN_BOOTSTRAP
    applyPluginBootstrapEnvDefaults()
    expect(process.env.LUMII_CLOAK_BROWSER_BOOTSTRAP).toBe(DEFAULT_LUMII_CLOAK_BROWSER_BOOTSTRAP)
    expect(process.env.LUMII_MEMPALACE_BOOTSTRAP).toBe(DEFAULT_LUMII_MEMPALACE_BOOTSTRAP)
    expect(isCloakBrowserBootstrapEnabled()).toBe(true)
    expect(isMemPalaceBootstrapEnabled()).toBe(true)
  })

  it('LUMII_SKIP_PLUGIN_BOOTSTRAP=1 时全部跳过', () => {
    saveEnv()
    process.env.LUMII_SKIP_PLUGIN_BOOTSTRAP = '1'
    expect(isCloakBrowserBootstrapEnabled()).toBe(false)
    expect(isMemPalaceBootstrapEnabled()).toBe(false)
  })

  it('单项设为 0 时仅关闭对应预安装', () => {
    saveEnv()
    process.env.LUMII_CLOAK_BROWSER_BOOTSTRAP = '0'
    process.env.LUMII_MEMPALACE_BOOTSTRAP = '1'
    expect(isCloakBrowserBootstrapEnabled()).toBe(false)
    expect(isMemPalaceBootstrapEnabled()).toBe(true)
  })
})
