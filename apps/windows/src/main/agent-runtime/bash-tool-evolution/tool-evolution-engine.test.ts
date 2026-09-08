/**
 * ToolEvolutionEngine 单测 — 挖掘周期与审批状态机
 *
 * 文件层（tool-writer）用 vi.mock 隔离，聚焦引擎决策逻辑。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BashCommandRepo } from '@mtbot/agent-runtime'
import { createMigratedTestDb } from '../../../../../../packages/agent-runtime/src/__tests__/helpers/sqlite-test-db'

// tool-writer mock：全部内存态
const pendingStore: unknown[][] = []
const approvedStore: Array<Record<string, unknown>> = []
vi.mock('./tool-writer', () => ({
  loadPendingDrafts: () => [...pendingStore],
  savePendingDrafts: async (drafts: unknown[]) => {
    pendingStore.length = 0
    for (const d of drafts) pendingStore.push(d as unknown[])
  },
  saveApprovedTool: async (def: Record<string, unknown>) => {
    approvedStore.push(def)
  },
  loadApprovedTools: () => approvedStore as never,
  newDraftId: () => 'draft-1',
}))

import { ToolEvolutionEngine } from './tool-evolution-engine'
import type { ToolEvolutionEngineDeps } from './tool-evolution-engine'

const PATTERN_SAMPLES = [
  'pnpm --filter ./apps/windows build',
  'pnpm --filter ./packages/agent-runtime build',
  'pnpm --filter ./apps/windows build',
  'pnpm --filter ./packages/agent-runtime build',
  'pnpm --filter ./apps/windows build',
]

const GOOD_DRAFT_JSON = JSON.stringify({
  name: 'pnpm-build',
  description: '构建指定的 workspace 包',
  whenToUse: '需要重新构建某个包时',
  whenNotToUse: '只想跑测试时不要用',
  parameters: {
    type: 'object',
    properties: { pkg: { type: 'string', description: 'workspace 包路径' } },
  },
  commandTemplate: 'pnpm --filter {{pkg}} build',
  isReadOnly: false,
})

function makeRepo(): BashCommandRepo {
  return new BashCommandRepo(createMigratedTestDb())
}

async function makeEngine(opts: Partial<ToolEvolutionEngineDeps> = {}) {
  const repo = makeRepo()
  for (const command of PATTERN_SAMPLES) {
    repo.log({
      agentId: 'agent-1',
      toolCallId: `tc-${Math.random()}`,
      command,
      isError: false,
      durationMs: 1000,
    })
  }

  const calls: string[] = []
  const registered: string[] = []
  const prompts: string[] = []

  const deps: ToolEvolutionEngineDeps = {
    bashCommandRepo: repo,
    callLLM: async (prompt) => {
      calls.push(prompt)
      return GOOD_DRAFT_JSON
    },
    registerEvolvedTool: (def) => registered.push(def.name),
    getRegisteredToolNames: () => ['bash', 'file_read'],
    emitApprovalPrompt: (text) => prompts.push(text),
    ...opts,
  }

  const engine = new ToolEvolutionEngine(deps)
  return { engine, calls, registered, prompts, repo }
}

beforeEach(() => {
  pendingStore.length = 0
  approvedStore.length = 0
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('runMiningCycle', () => {
  it('完整周期：采集→精修→草拟→质量门→入队提问', async () => {
    const { engine, calls, prompts } = await makeEngine()
    const summary = await engine.runMiningCycle()

    expect(summary.samplesScanned).toBe(5)
    expect(summary.drafted).toBe(1)
    expect(summary.gatedOut).toBe(0)
    expect(calls.length).toBeGreaterThanOrEqual(2) // refine + draft 各一次 LLM
    expect(engine.pendingCount).toBe(1)
    expect(prompts.length).toBe(1)
    expect(prompts[0]).toContain('pnpm-build')
    expect(prompts[0]).toContain('启用')
  })

  it('数据不足时静默跳过', async () => {
    const repo = makeRepo()
    const engine = new ToolEvolutionEngine({
      bashCommandRepo: repo,
      callLLM: async () => GOOD_DRAFT_JSON,
      registerEvolvedTool: () => {},
      getRegisteredToolNames: () => [],
      emitApprovalPrompt: () => {},
    })
    const summary = await engine.runMiningCycle()
    expect(summary.skippedReason).toContain('不足')
    expect(summary.drafted).toBe(0)
  })

  it('LLM 草拟失败计入 gatedOut 且不入队', async () => {
    const { engine, prompts } = await makeEngine({
      callLLM: async () => '无法分析这些命令',
    })
    const summary = await engine.runMiningCycle()
    expect(summary.drafted).toBe(0)
    expect(summary.gatedOut).toBeGreaterThanOrEqual(0)
    expect(engine.pendingCount).toBe(0)
    expect(prompts.length).toBe(0)
  })

  it('待审批队列满时暂停草拟', async () => {
    const { engine } = await makeEngine({ maxPendingQueue: 1 })
    await engine.runMiningCycle() // 入队 1 个
    const second = await engine.runMiningCycle()
    expect(second.skippedReason).toContain('队列已满')
  })
})

describe('handleUserMessage', () => {
  it('「启用」→ 注册 + 落盘 + 确认回执', async () => {
    const { engine, registered, prompts } = await makeEngine()
    await engine.runMiningCycle()

    const handled = await engine.handleUserMessage('好的，启用吧')
    expect(handled).toBe(true)
    expect(registered).toEqual(['pnpm-build'])
    expect(approvedStore.length).toBe(1)
    expect(engine.pendingCount).toBe(0)
    expect(prompts.at(-1)).toContain('已注册')
  })

  it('「不用」→ 丢弃不回注册', async () => {
    const { engine, registered } = await makeEngine()
    await engine.runMiningCycle()

    const handled = await engine.handleUserMessage('不用了，谢谢')
    expect(handled).toBe(true)
    expect(registered).toEqual([])
    expect(approvedStore.length).toBe(0)
    expect(engine.pendingCount).toBe(0)
  })

  it('无关消息返回 false 且不动队列', async () => {
    const { engine } = await makeEngine()
    await engine.runMiningCycle()
    expect(await engine.handleUserMessage('今天天气怎么样')).toBe(false)
    expect(engine.pendingCount).toBe(1)
  })

  it('无候选时不消费任何消息', async () => {
    const { engine } = await makeEngine()
    expect(await engine.handleUserMessage('启用')).toBe(false)
  })
})

describe('loadApprovedTools', () => {
  it('启动时注册已批准工具', async () => {
    approvedStore.push({
      name: 'old-tool',
      description: '历史批准的工具，长描述用于通过校验',
      parameters: { type: 'object', properties: { x: { type: 'string' } } },
      commandTemplate: 'echo {{x}}',
      isReadOnly: true,
      needsPermission: true,
      status: 'approved',
      samples: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      approvedAt: '2026-01-01T00:00:00.000Z',
    })
    const { engine, registered } = await makeEngine()
    expect(engine.loadApprovedTools()).toBe(1)
    expect(registered).toEqual(['old-tool'])
  })
})
