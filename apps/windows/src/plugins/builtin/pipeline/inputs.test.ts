/**
 * 运行时变量（`{{input.xxx}}`）。
 *
 * 这条能力的存在理由是实测出来的：`web-clone` 7 次运行只 2 次成功，其中一次就是
 * `Page.navigate: Cannot navigate to invalid URL`（`__TARGET_URL__` 没替换）。
 * 所以测试守的不是「能替换」，而是**没填时必须在这里失败，不许静默换成空串**。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runPipeline } from './runner'
import { validateSpec, collectInputNames } from './spec'
import type { RunnerDeps } from './types'

const TOOLS = new Set(['bash', 'app_goto'])
const AGENTS = new Set(['assistant'])

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-inputs-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const fastSleep = () => Promise.resolve()

function specOf(raw: unknown) {
  const r = validateSpec(raw, TOOLS, AGENTS)
  if (!r.ok) throw new Error('bad spec: ' + r.errors.join('; '))
  return r
}

function deps(): { d: RunnerDeps } {
  return {
    d: {
      callTool: vi.fn(async () => ({ ok: true, data: { ok: true } })),
      readViewState: vi.fn(async () => ({ view: 'chat' })),
      now: () => 1000,
      screenRecord: null,
    },
  }
}

const run = (spec: ReturnType<typeof specOf>['spec'], inputs?: Record<string, string>) => {
  const { d } = deps()
  return runPipeline({
    spec, specHash: 'x', mode: 'rehearsal', runDir: path.join(dir, 'r'),
    deps: d, sleep: fastSleep, isRehearsalBlocked: () => false, inputs,
  }).then((res) => ({ res, d }))
}

describe('{{input.xxx}} 的加载期推导', () => {
  it('从引用里推出变量名与样例，作者不用声明', () => {
    const names = collectInputNames({ a: '{{input.repoUrl}}', b: ['x', '{{input.topic}}'] })
    expect([...names.keys()]).toEqual(['repoUrl', 'topic'])
    expect(names.get('repoUrl')).toBe('{{input.repoUrl}}')
  })

  it('校验通过：input 引用不被当成"不存在的 step"', () => {
    const { spec } = specOf({
      id: 'x',
      steps: [{ id: 'a', tool: 'bash', params: { command: 'git clone {{input.repoUrl}}' } }],
    })
    expect(spec.inputs).toEqual([{ name: 'repoUrl' }])
    expect(spec.inputTemplate).toEqual({ repoUrl: '{{input.repoUrl}}' })
  })

  it('postCleanup 里引用的变量同样被收进来', () => {
    const { spec } = specOf({
      id: 'x',
      steps: [{ id: 'a', tool: 'bash' }],
      postCleanup: [{ id: 'c', tool: 'bash', params: { command: 'rm -rf {{input.workDir}}' } }],
    })
    expect(spec.inputs?.map((i) => i.name)).toEqual(['workDir'])
  })

  it('没有变量时不写 inputs / inputTemplate（别给老 spec 加空字段）', () => {
    const { spec } = specOf({ id: 'x', steps: [{ id: 'a', tool: 'bash' }] })
    expect(spec.inputs).toBeUndefined()
    expect(spec.inputTemplate).toBeUndefined()
  })

  it('step 名恰好叫 input 时按变量解析，不再当步骤（这是保留字）', () => {
    const { spec } = specOf({
      id: 'x',
      steps: [{ id: 'a', tool: 'bash', params: { command: 'echo {{input.x}}' } }],
    })
    expect(spec.inputs?.[0]?.name).toBe('x')
  })
})

describe('{{input.xxx}} 的运行期解析', () => {
  it('传了值 → 替换进 params', async () => {
    const { spec } = specOf({
      id: 'x',
      steps: [{ id: 'a', tool: 'bash', params: { command: 'git clone {{input.repoUrl}}' } }],
    })
    const { d, res } = await run(spec, { repoUrl: 'https://github.com/a/b' })
    expect(res.ok).toBe(true)
    expect(d.callTool).toHaveBeenCalledWith(
      'bash', { command: 'git clone https://github.com/a/b' }, undefined,
    )
  })

  it('整串就是一个引用 → 值是原样字符串，不套引号', async () => {
    const { spec } = specOf({
      id: 'x',
      steps: [{ id: 'a', tool: 'bash', params: { command: '{{input.cmd}}' } }],
    })
    const { d } = await run(spec, { cmd: 'echo hi' })
    expect(d.callTool).toHaveBeenCalledWith('bash', { command: 'echo hi' }, undefined)
  })

  it('**没传变量 → 在用到它的那一步失败，不静默换成空串**', async () => {
    const { spec } = specOf({
      id: 'x',
      steps: [
        { id: 'first', tool: 'app_goto' },
        { id: 'second', tool: 'bash', params: { command: 'git clone {{input.repoUrl}}' } },
      ],
    })
    const { d, res } = await run(spec)
    // 前一步照跑完：这样用户能同时看到「spec 前几步是通的」与「只是变量没填」
    expect(res.ok).toBe(false)
    expect(res.failedAt?.id).toBe('second')
    expect(res.error).toContain('input.repoUrl')
    expect(res.error).toContain('运行时没传这个变量')
    expect(d.callTool).not.toHaveBeenCalledWith('bash', expect.anything(), expect.anything())
  })

  it('传了空串也算"传了"（空值是有意义的值，不该报错）', async () => {
    const { spec } = specOf({
      id: 'x',
      steps: [{ id: 'a', tool: 'bash', params: { command: 'echo "{{input.note}}"' } }],
    })
    const { res } = await run(spec, { note: '' })
    expect(res.ok).toBe(true)
  })

  it('agent 节点的 prompt 同样解析变量', async () => {
    const { spec } = specOf({
      id: 'x',
      steps: [{ id: 'a', kind: 'agent', prompt: '评测 {{input.repoUrl}}', rehearsal: 'run' }],
    })
    const runAgentStage = vi.fn(async () => ({ ok: true, data: { output: 'done' } }))
    await runPipeline({
      spec, specHash: 'x', mode: 'rehearsal', runDir: path.join(dir, 'r2'),
      deps: {
        callTool: vi.fn(async () => ({ ok: true })),
        runAgentStage,
        readViewState: async () => ({ view: 'chat' }),
        now: () => 1000,
        screenRecord: null,
      },
      sleep: fastSleep,
      isRehearsalBlocked: () => false,
      inputs: { repoUrl: 'https://github.com/a/b' },
    })
    expect(runAgentStage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: '评测 https://github.com/a/b' }),
      undefined,
    )
  })

  it('变量进 journal 与 meta（回看时知道那次跑的是哪个仓库）', async () => {
    const { spec } = specOf({
      id: 'x',
      steps: [{ id: 'a', tool: 'bash', params: { command: 'echo {{input.x}}' } }],
    })
    const { res } = await run(spec, { x: 'v' })
    const meta = JSON.parse(fs.readFileSync(path.join(res.journalPath, '..', 'meta.json'), 'utf8'))
    expect(meta.inputs).toEqual({ x: 'v' })
  })
})
