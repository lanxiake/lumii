/**
 * 最小闭环：团队 + 流水线 + 归属。
 *
 * 跑的是**真实的** store / spec 校验 / service / runner（只有 LLM 那一层是假的），
 * 验证这条链路真的能把「一个专家带自己的技能与流水线」跑完：
 *
 *   spec.owner         → pipeline_list 只给主人看
 *   spec.steps[agent]  → 真正调到 runAgentStage（子 Agent 拿自包含 prompt）
 *   {{step.output}}    → 上游产出真的进了下游 prompt
 *   expect 失败        → failedAt 指出是哪一步、期望什么、实际什么
 *
 * 判据全部落在**产物与返回值**上，不看日志。
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPipelineService, type PipelineServiceDeps } from './runtime'
import { createPipelineToolConfigs } from './tools'
import type { RunAgentStageData } from './types'

let root: string
let workspace: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-team-closure-'))
  workspace = path.join(root, 'pipelines')
  fs.mkdirSync(workspace, { recursive: true })
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

function writeSpec(id: string, spec: Record<string, unknown>) {
  const dir = path.join(workspace, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify({ id, ...spec }, null, 2))
}

const TOOLS = new Set(['bash', 'file_write', 'file_read'])
const AGENTS = new Set(['assistant', 'video-pro'])

function deps(over: Partial<PipelineServiceDeps> = {}) {
  const prompts: string[] = []
  const d: PipelineServiceDeps = {
    callTool: vi.fn(async () => ({ ok: true, data: { ok: true } })),
    runAgentStage: vi.fn(async (p): Promise<{ ok: boolean; data?: RunAgentStageData }> => {
      prompts.push(p.prompt)
      return { ok: true, data: { output: 'PROMPT_DRAFT_OK', agentName: '视频专家' } }
    }),
    screenRecord: null,
    readViewState: async () => ({ view: 'chat' }),
    knownTools: () => TOOLS,
    knownAgents: () => AGENTS,
    needsPermission: () => false,
    pipelinesRoot: () => workspace,
    workspaceRoot: () => root,
    now: () => 1000,
    ...over,
  }
  return { d, prompts }
}

describe('团队 + 流水线最小闭环', () => {
  it('agent 节点真被调用，上游产出进下游 prompt，整条 run 成功', async () => {
    writeSpec('video-flow', {
      description: '视频专家专用',
      owner: 'video-pro',
      steps: [
        {
          id: 'brief',
          kind: 'agent',
          agentType: 'video-pro',
          prompt: '为「{{input.topic}}」写分镜 brief',
          rehearsal: 'run',
        },
        {
          id: 'shots',
          kind: 'agent',
          agentType: 'video-pro',
          prompt: '按这份 brief 拆镜头：{{brief.output}}',
          rehearsal: 'run',
        },
      ],
    })

    const { d, prompts } = deps()
    const svc = createPipelineService(d)
    const res = await svc.run('video-flow', { mode: 'rehearsal', inputs: { topic: '城市夜骑' } })

    expect(res.ok).toBe(true)
    expect(res.steps.map((s) => s.id)).toEqual(['brief', 'shots'])
    // 两条 agent 步骤都真的跑了（不是「宿主不支持」的失败）
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('城市夜骑')
    // 关键：上游 agent 的输出被 {{brief.output}} 解析成了真值
    expect(prompts[1]).toContain('PROMPT_DRAFT_OK')
    expect(prompts[1]).not.toContain('{{brief.output}}')
  })

  it('agent 步失败 → failedAt 指出第几步，run 停在那里不再往下跑', async () => {
    writeSpec('video-flow', {
      steps: [
        { id: 'brief', kind: 'agent', agentType: 'video-pro', prompt: '写 brief', rehearsal: 'run' },
        { id: 'shots', kind: 'agent', agentType: 'video-pro', prompt: '拆镜头', rehearsal: 'run' },
      ],
    })
    const { d, prompts } = deps({
      runAgentStage: async () => ({ ok: false, error: '子 Agent 回合预算耗尽' }),
    })
    const res = await createPipelineService(d).run('video-flow', { mode: 'rehearsal' })

    expect(res.ok).toBe(false)
    expect(res.failedAt?.id).toBe('brief')
    expect(res.failedAt?.i).toBe(0)
    expect(prompts).toHaveLength(0)
  })

  it('pipeline_list 按 owner 收敛：视频专家看得见，助手只看得见公共的', async () => {
    writeSpec('shared-flow', { description: '公共', steps: [{ id: 'a', tool: 'bash', params: {} }] })
    writeSpec('video-flow', {
      description: '视频专用',
      owner: 'video-pro',
      steps: [{ id: 'a', tool: 'bash', params: {} }],
    })
    const { d } = deps()
    const svc = createPipelineService(d)

    const asVideo = createPipelineToolConfigs(svc, { definitionIdOf: () => 'video-pro' }).find(
      (c) => c.name === 'pipeline_list',
    )!
    const asAssistant = createPipelineToolConfigs(svc, { definitionIdOf: () => 'assistant' }).find(
      (c) => c.name === 'pipeline_list',
    )!

    const read = async (cfg: typeof asVideo) => {
      const r = await cfg.execute('call-1', {}, {})
      const json = JSON.parse((r.content[0] as { text: string }).text) as {
        pipelines: { id: string }[]
      }
      return json.pipelines.map((p) => p.id).sort()
    }

    expect(await read(asVideo)).toEqual(['shared-flow', 'video-flow'])
    expect(await read(asAssistant)).toEqual(['shared-flow'])
  })

  it('spec 里的未知 agentType → 加载期拒绝，不进运行期', async () => {
    writeSpec('bad-agent', {
      steps: [{ id: 'a', kind: 'agent', agentType: 'ghost-pro', prompt: 'x' }],
    })
    const res = await createPipelineService(deps().d).run('bad-agent', { mode: 'rehearsal' })
    expect(res.ok).toBe(false)
    expect(String(res.error)).toContain('ghost-pro')
  })
})
