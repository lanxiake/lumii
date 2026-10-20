import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSamplePlugin } from './plugin-template'

describe('createSamplePlugin', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lumii-plugin-template-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('生成三件套，且 id 一致', () => {
    const result = createSamplePlugin(dir)

    expect(result.ok).toBe(true)
    const pluginDir = path.join(dir, 'my-plugin')
    expect(result.dir).toBe(pluginDir)
    for (const file of ['plugin.json', 'client.js', 'README.md']) {
      expect(existsSync(path.join(pluginDir, file))).toBe(true)
    }

    const meta = JSON.parse(readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'))
    expect(meta.id).toBe('my-plugin')
    // 一个插件 = 一个 id = 一次注册；模板里的注册 id 必须与 plugin.json 一致
    expect(readFileSync(path.join(pluginDir, 'client.js'), 'utf8')).toContain(
      "__LUMII_REGISTER_PLUGIN__('my-plugin'",
    )
  })

  it('client.js 是能解析的 JS（模板本身写坏了要在这里暴露）', () => {
    createSamplePlugin(dir)
    const source = readFileSync(path.join(dir, 'my-plugin', 'client.js'), 'utf8')

    // 只编译不执行：顶层唯一的副作用是调用宿主注入的全局
    expect(() => new Function('__LUMII_REGISTER_PLUGIN__', source)).not.toThrow()
  })

  it('重复生成时目录自动避让，不覆盖已有插件', () => {
    const first = createSamplePlugin(dir)
    const second = createSamplePlugin(dir)

    expect(first.dir).toBe(path.join(dir, 'my-plugin'))
    expect(second.dir).toBe(path.join(dir, 'my-plugin-2'))
    expect(readFileSync(path.join(dir, 'my-plugin-2', 'plugin.json'), 'utf8')).toContain('my-plugin-2')
  })
})
