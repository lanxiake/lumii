import { describe, expect, it, vi } from 'vitest'
import { createPipelineToolConfigs, PIPELINE_TOOL_NAMES } from './tools'

function deps(over: Record<string, unknown> = {}) {
  const base = {
    list: vi.fn(async () => [
      { id: 'demo', name: '演示', stepCount: 2, narrationCount: 1 },
    ]),
    run: vi.fn(async () => ({
      ok: true, runId: 'r1', journalPath: '/x/j.jsonl',
      steps: [{ id: 'a', ok: true, ms: 5 }],
    })),
    // service-api 的方法名是 detail（不是 inspect）；tool 名才叫 pipeline_inspect
    detail: vi.fn(async () => ({
      spec: { id: 'demo', steps: [{ id: 'a', tool: 'app_act', holdMs: 800 }] },
      specHash: 'h',
      runs: [],
      lastJournal: [],
    })),
    ...over,
  }
  return base
}

type TestDeps = ReturnType<typeof deps>

function config(name: string, d: TestDeps) {
  const found = createPipelineToolConfigs(d as never).find((c) => c.name === name)
  if (!found) throw new Error(`no tool ${name}`)
  return found
}

/** 取 content[0].text 解析（工具结果契约：details 会被清空，模型只看 content） */
async function exec(name: string, params: unknown, d: TestDeps) {
  const c = config(name, d)
  const res = await c.execute('call-1', params as never, {} as never)
  const text = (res.content[0] as { text: string }).text
  return { ...res, json: JSON.parse(text) as Record<string, unknown> }
}

describe('pipeline tools', () => {
  it('三个工具名齐备', () => {
    expect([...PIPELINE_TOOL_NAMES].sort()).toEqual(['pipeline_inspect', 'pipeline_list', 'pipeline_run'])
  })

  it('工具描述写清 §7.4 的三条判据（模型只读描述）', () => {
    const d = deps()
    const run = config('pipeline_run', d)
    expect(run.description).toMatch(/枚举/)
    expect(run.description).toMatch(/断言|可断言|断言结果/)
    expect(run.description).toMatch(/重复/)
  })

  it('pipeline_list 无参可用', async () => {
    const d = deps()
    const r = await exec('pipeline_list', {}, d)
    expect(r.isError).toBeFalsy()
    expect(r.json).toMatchObject({ total: 1 })
  })

  it('pipeline_run 缺 id → isError:true，content 里有人话原因', async () => {
    const d = deps()
    const r = await exec('pipeline_run', {}, d)
    expect(r.isError).toBe(true)
    expect(String(r.json.message ?? r.json.error)).toMatch(/id/)
    expect(d.run).not.toHaveBeenCalled()
  })

  it('pipeline_run 非法 mode → isError:true', async () => {
    const d = deps()
    const r = await exec('pipeline_run', { id: 'demo', mode: 'nonsense' }, d)
    expect(r.isError).toBe(true)
    expect(d.run).not.toHaveBeenCalled()
  })

  it('pipeline_run 合法 → 返回 run 结果，steps 与 failedAt 都可见', async () => {
    const d = deps()
    const r = await exec('pipeline_run', { id: 'demo', mode: 'rehearsal' }, d)
    expect(r.isError).toBeFalsy()
    expect(r.json).toMatchObject({ status: 'ok', runId: 'r1' })
    expect(d.run).toHaveBeenCalledWith('demo', { mode: 'rehearsal', resumeRunId: undefined })
  })

  it('pipeline_run 失败时把 failedAt/expected/observed 放进 content（模型只能看 content）', async () => {
    const d = deps({
      run: vi.fn(async () => ({
        ok: false, runId: 'r2', journalPath: '/x/j.jsonl', steps: [],
        failedAt: { i: 1, id: 'b', expected: { ok: true }, observed: { ok: false } },
        error: '断言失败',
      })),
    })
    const r = await exec('pipeline_run', { id: 'demo' }, d)
    expect(r.isError).toBe(true)
    expect(r.json.failedAt).toBeDefined()
    expect(JSON.stringify(r.json)).toContain('断言失败')
  })

  it('pipeline_inspect 缺 id → isError:true', async () => {
    const d = deps()
    const r = await exec('pipeline_inspect', {}, d)
    expect(r.isError).toBe(true)
    expect(d.detail).not.toHaveBeenCalled()
  })

  it('pipeline_inspect 合法 → 返回 journal 摘要', async () => {
    const d = deps()
    const r = await exec('pipeline_inspect', { id: 'demo' }, d)
    expect(r.isError).toBeFalsy()
    expect(r.json).toMatchObject({ specId: 'demo' })
  })

  it('service 抛异常 → 变成 isError:true 的可读结果，不让异常外逸', async () => {
    const d = deps({ list: vi.fn(async () => { throw new Error('磁盘炸了') }) })
    const r = await exec('pipeline_list', {}, d)
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r.json)).toContain('磁盘炸了')
  })
})
