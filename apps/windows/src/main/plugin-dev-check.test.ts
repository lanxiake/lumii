// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { checkPlugin } from './plugin-dev-check'
import { createSamplePlugin } from './plugin-template'

function writeClient(root: string, dirName: string, source: string, meta?: object): void {
  const dir = path.join(root, dirName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'client.js'), source, 'utf8')
  if (meta) writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(meta), 'utf8')
}

const GOOD = `__LUMII_REGISTER_PLUGIN__('good', (api) => {
  api.registerSlot('dashboard.plugins', { id: 'good.card', component: () => null })
})`

describe('checkPlugin（客户端）', () => {
  let root: string
  let mainRoot: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'lumii-dev-check-'))
    mainRoot = path.join(root, 'extensions')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function check(id: string, appVersion?: string) {
    return checkPlugin({ kind: 'client', id, clientRoot: root, mainRoot, appVersion })
  }

  it('好插件：ok 且无错误', () => {
    writeClient(root, 'good', GOOD, { id: 'good', name: '好', version: '0.1.0' })

    const result = check('good')

    expect(result.ok).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.meta).toMatchObject({ id: 'good', version: '0.1.0' })
  })

  it('engines 不满足当前客户端：报 incompatible，且来源标记可读', () => {
    writeClient(root, 'future', GOOD, {
      id: 'future',
      version: '0.1.0',
      origin: 'agent',
      engines: { lumii: '>=99.0.0' },
    })

    const result = check('future', '0.1.5')

    expect(result.errors.map((e) => e.code)).toContain('incompatible')
    expect(result.meta).toMatchObject({ origin: 'agent' })
  })

  it('「新建示例插件」生成的东西必须自己过体检（模板与检查器不能各说各话）', () => {
    expect(createSamplePlugin(root).ok).toBe(true)

    const result = check('my-plugin')

    expect(result.errors).toEqual([])
  })

  it('目录不存在 / 非法名字：给出可读错误', () => {
    expect(check('nope').errors[0]?.code).toBe('dir_missing')
    expect(check('../etc').errors[0]?.code).toBe('bad_id')
  })

  it('没调用注册 / 调用两次：都是错误', () => {
    writeClient(root, 'none', '// 什么也没做')
    writeClient(root, 'twice', `${GOOD}\n${GOOD}`)

    expect(check('none').errors.map((e) => e.code)).toContain('no_register')
    expect(check('twice').errors.map((e) => e.code)).toContain('multi_register')
  })

  it('语法错误不会让脚本生效', () => {
    writeClient(root, 'broken', 'export default { this is not valid js')

    expect(check('broken').errors.map((e) => e.code)).toContain('syntax')
  })

  it('注册 id 与 plugin.json 的 id 不一致', () => {
    // plugin.json 说 id 是 good，注册调用写的却是 other
    writeClient(root, 'mismatch', GOOD.replace("'good'", "'other'"), { id: 'good' })

    const codes = check('mismatch').errors.map((e) => e.code)
    expect(codes).toContain('register_id_mismatch')
  })

  it('两个目录共用同一个 id（复制目录忘改）', () => {
    writeClient(root, 'a', GOOD.replace("'good'", "'same'"), { id: 'same' })
    writeClient(root, 'b', GOOD.replace("'good'", "'same'"), { id: 'same' })

    expect(check('a').errors.map((e) => e.code)).toContain('duplicate_id')
  })

  it('未知槽位是错误；硬编码色是警告', () => {
    writeClient(
      root,
      'warn',
      `__LUMII_REGISTER_PLUGIN__('warn', (api) => {
  api.registerSlot('nope.slot', { id: 'warn.x', component: () => null })
  const color = '#ff0000'
  void color
})`,
    )

    const result = check('warn')
    expect(result.errors.map((e) => e.code)).toContain('unknown_slot')
    expect(result.warnings.map((w) => w.code)).toContain('hardcoded_color')
  })

  it('import/require 是错误（插件以经典脚本执行）', () => {
    writeClient(root, 'esm', `import x from 'x'\n${GOOD}`)
    writeClient(root, 'cjs', `const x = require('x')\n${GOOD}`)

    expect(check('esm').errors.map((e) => e.code)).toContain('esm_import')
    expect(check('cjs').errors.map((e) => e.code)).toContain('require')
  })
})

describe('checkPlugin（主进程）', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'lumii-dev-main-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('缺少 export default / 具名导出时报错', () => {
    const dir = path.join(root, 'ext')
    mkdirSync(dir)
    writeFileSync(path.join(dir, 'main.js'), 'const x = 1\n', 'utf8')

    const result = checkPlugin({ kind: 'main', id: 'ext', clientRoot: root, mainRoot: root })
    expect(result.errors.map((e) => e.code)).toContain('main_exports')
  })

  it('export default 形状通过（语法错误留给加载器）', () => {
    const dir = path.join(root, 'ext2')
    mkdirSync(dir)
    writeFileSync(path.join(dir, 'main.js'), 'export default { manifest: {}, definition: {} }\n', 'utf8')

    expect(checkPlugin({ kind: 'main', id: 'ext2', clientRoot: root, mainRoot: root }).ok).toBe(true)
  })
})
