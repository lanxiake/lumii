import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listPipelines, createRunDir } from './store'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-pipe-store-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function writeSpec(id: string, body: unknown) {
  const d = path.join(dir, id)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'spec.json'), JSON.stringify(body), 'utf8')
}

const TOOLS = new Set(['app_goto', 'app_act'])

describe('store', () => {
  it('空目录 → 空列表，不抛', () => {
    expect(listPipelines(dir, TOOLS)).toEqual([])
  })

  it('两条 spec 都能列出，字段正确', () => {
    writeSpec('one', {
      id: 'one', name: '第一条',
      steps: [
        { id: 'a', tool: 'app_goto', narration: 'n1' },
        { id: 'b', tool: 'app_act' },
      ],
    })
    writeSpec('two', { id: 'two', steps: [{ id: 'x', tool: 'app_act', narration: 'n' }] })
    const list = listPipelines(dir, TOOLS)
    expect(list.map((p) => p.id).sort()).toEqual(['one', 'two'])
    const one = list.find((p) => p.id === 'one')!
    expect(one.name).toBe('第一条')
    expect(one.stepCount).toBe(2)
    expect(one.narrationCount).toBe(1)
  })

  it('坏 spec 不抛，标 {error} 让 UI 显示「这条 spec 坏了」', () => {
    writeSpec('good', { id: 'good', steps: [{ id: 'a', tool: 'app_act' }] })
    writeSpec('bad', { id: 'bad', steps: [{ id: 'a', tool: 'nope' }] })
    const list = listPipelines(dir, TOOLS)
    const bad = list.find((p) => p.id === 'bad')!
    expect(bad.error).toBeTruthy()
    expect(list.find((p) => p.id === 'good')!.error).toBeUndefined()
  })

  it('runs/ 不参与列举', () => {
    writeSpec('one', { id: 'one', steps: [{ id: 'a', tool: 'app_act' }] })
    fs.mkdirSync(path.join(dir, 'one', 'runs', '20261029-120000-abc123'), { recursive: true })
    expect(listPipelines(dir, TOOLS).map((p) => p.id)).toEqual(['one'])
  })

  it('lastRun 从 meta.json 读回', () => {
    writeSpec('one', { id: 'one', steps: [{ id: 'a', tool: 'app_act' }] })
    const runDir = path.join(dir, 'one', 'runs', '20261029-120000-abc123')
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      path.join(runDir, 'meta.json'),
      JSON.stringify({ runId: 'r', specId: 'one', mode: 'rehearsal', specHash: 'h', startedAt: 5, status: 'ok' }),
    )
    const one = listPipelines(dir, TOOLS).find((p) => p.id === 'one')!
    expect(one.lastRun).toMatchObject({ ok: true })
  })

  it('createRunDir 建目录 + 写 spec 快照与 sha256，且 runs/ 下可被列举', () => {
    const { runDir } = createRunDir(dir, 'one', { id: 'one', steps: [] }, 'deadbeef')
    expect(fs.existsSync(path.join(runDir, 'spec.snapshot.json'))).toBe(true)
    expect(fs.readFileSync(path.join(runDir, 'spec.sha256'), 'utf8').trim()).toBe('deadbeef')
    // 名字形如 yyyymmdd-hhmmss-xxxxxx
    expect(path.basename(runDir)).toMatch(/^\d{8}-\d{6}-[a-z0-9]{6}$/)
  })
})
