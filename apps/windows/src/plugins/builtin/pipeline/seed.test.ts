/**
 * 播种的基线判据。
 *
 * 这块的风险是**不可逆**：判错一次就把用户改过的 spec 覆盖掉。所以三条路径都要钉住：
 * 没基线不动、没改过升级、改过保留。另外两条容易写错的：
 * - `inputs.json`（用户填的运行输入）不能算进"改没改过"，也不能被升级冲掉；
 * - `runs/`（运行产物）同理，否则跑过一次之后所有 spec 都变成"用户改过"。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { seedBundledPipelines } from './index'

let root: string
let src: string
let dst: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-seed-'))
  src = path.join(root, 'bundled')
  dst = path.join(root, 'pipelines')
  fs.mkdirSync(path.join(src, 'demo'), { recursive: true })
  fs.mkdirSync(dst, { recursive: true })
  fs.writeFileSync(path.join(src, 'demo', 'spec.json'), JSON.stringify({ id: 'demo', steps: [{ id: 'a', tool: 'bash' }] }))
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const specOf = (dir: string) => fs.readFileSync(path.join(dir, 'spec.json'), 'utf8')

describe('seedBundledPipelines 基线判据', () => {
  it('目标不存在 → 播种，并写下基线', () => {
    const r = seedBundledPipelines(src, dst)
    expect(r).toEqual({ seeded: 1, updated: 0, kept: 0 })
    expect(specOf(path.join(dst, 'demo'))).toBe(specOf(path.join(src, 'demo')))
    expect(fs.existsSync(path.join(dst, 'demo', '.bundled-pipeline-hash'))).toBe(true)
  })

  it('**用户改过 → 保留，不覆盖**（这是全模块最不能错的一条）', () => {
    seedBundledPipelines(src, dst)
    const userSpec = '{"id":"demo","steps":[{"id":"mine","tool":"bash"}]}'
    fs.writeFileSync(path.join(dst, 'demo', 'spec.json'), userSpec)
    // 上游又发了一版
    fs.writeFileSync(path.join(src, 'demo', 'spec.json'), '{"id":"demo","steps":[]}')

    const r = seedBundledPipelines(src, dst)
    expect(r).toEqual({ seeded: 0, updated: 0, kept: 1 })
    expect(specOf(path.join(dst, 'demo'))).toBe(userSpec)
  })

  it('没改过 → 用新版覆盖（否则修好的 spec 永远到不了老用户）', () => {
    seedBundledPipelines(src, dst)
    const newer = JSON.stringify({ id: 'demo', steps: [{ id: 'b', tool: 'list_dir' }] })
    fs.writeFileSync(path.join(src, 'demo', 'spec.json'), newer)

    const r = seedBundledPipelines(src, dst)
    expect(r).toEqual({ seeded: 0, updated: 1, kept: 0 })
    expect(specOf(path.join(dst, 'demo'))).toBe(newer)
  })

  it('**没有基线 → 不动**（分不清"用户改过"与"只是旧"，覆盖不可逆）', () => {
    fs.mkdirSync(path.join(dst, 'demo'))
    const legacy = '{"id":"demo","steps":[]}'
    fs.writeFileSync(path.join(dst, 'demo', 'spec.json'), legacy)

    const r = seedBundledPipelines(src, dst)
    expect(r).toEqual({ seeded: 0, updated: 0, kept: 1 })
    expect(specOf(path.join(dst, 'demo'))).toBe(legacy)
  })

  it('runs/ 里的运行产物不算"用户改过"', () => {
    seedBundledPipelines(src, dst)
    fs.mkdirSync(path.join(dst, 'demo', 'runs', 'r1'), { recursive: true })
    fs.writeFileSync(path.join(dst, 'demo', 'runs', 'r1', 'journal.jsonl'), '{"ok":true}\n')

    const newer = JSON.stringify({ id: 'demo', steps: [{ id: 'c', tool: 'bash' }] })
    fs.writeFileSync(path.join(src, 'demo', 'spec.json'), newer)
    expect(seedBundledPipelines(src, dst).updated).toBe(1)
  })

  it('inputs.json 不算"改过"，且升级时**保留用户填的值**', () => {
    seedBundledPipelines(src, dst)
    const userInputs = '{"repoUrl":"https://github.com/me/mine"}'
    fs.writeFileSync(path.join(dst, 'demo', 'inputs.json'), userInputs)

    fs.writeFileSync(path.join(src, 'demo', 'spec.json'), JSON.stringify({ id: 'demo', steps: [{ id: 'd', tool: 'bash' }] }))
    const r = seedBundledPipelines(src, dst)
    expect(r.updated).toBe(1)
    // 覆盖的是 spec，不是用户填的运行输入
    expect(fs.readFileSync(path.join(dst, 'demo', 'inputs.json'), 'utf8')).toBe(userInputs)
  })

  it('有变量的新流水线会播一份 inputs.json 模板，把引用的原样文本当样例', () => {
    fs.mkdirSync(path.join(src, 'vars'))
    fs.writeFileSync(
      path.join(src, 'vars', 'spec.json'),
      JSON.stringify({ id: 'vars', steps: [{ id: 'a', tool: 'bash', params: { command: 'git clone {{input.repoUrl}}' } }] }),
    )
    seedBundledPipelines(src, dst)
    const tpl = JSON.parse(fs.readFileSync(path.join(dst, 'vars', 'inputs.json'), 'utf8'))
    expect(tpl).toEqual({ repoUrl: '{{input.repoUrl}}' })
  })
})
