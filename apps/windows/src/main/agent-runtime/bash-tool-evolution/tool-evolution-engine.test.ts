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
    approvedStore.push({ ...def, status: 'approved' })
  },
  loadApprovedTools: () =>
    approvedStore.filter((d) => d.status === 'approved') as never,
  loadStoredTools: () =>
    approvedStore.map((def) => ({ def, status: def.status as 'approved' | 'disabled' })),
  updateToolStatus: (name: string, status: 'approved' | 'disabled') => {
    const def = approvedStore.find((d) => d.name === name)
    if (!def) return false
    def.status = status
    return true
  },
  removeApprovedTool: (name: string) => {
    const idx = approvedStore.findIndex((d) => d.name === name)
    if (idx >= 0) approvedStore.splice(idx, 1)
  },
  newDraftId: () => 'draft-1',
}))

import {
  ToolEvolutionEngine,
  buildApprovalPrompt,
  canonicalizeParamSlots,
  clampTriggerThreshold,
  DEFAULT_TRIGGER_THRESHOLD,
  WEEK_MS,
} from './tool-evolution-engine'
import type { ToolEvolutionEngineDeps } from './tool-evolution-engine'
import type { PendingToolDraft } from './tool-writer'

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

/** 单测默认放宽次数门槛；生产默认仍为 count>100 */
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
  let lastMiningAt: string | null = null

  const deps: ToolEvolutionEngineDeps = {
    bashCommandRepo: repo,
    callLLM: async (prompt) => {
      calls.push(prompt)
      return GOOD_DRAFT_JSON
    },
    registerEvolvedTool: (def) => registered.push(def.name),
    unregisterTool: (name) => {
      const idx = registered.indexOf(name)
      if (idx >= 0) registered.splice(idx, 1)
    },
    getRegisteredToolNames: () => ['bash', 'file_read'],
    emitApprovalPrompt: (text) => prompts.push(text),
    minCountExclusive: 4,
    miningCooldownMs: 0,
    getLastMiningAt: () => lastMiningAt,
    setLastMiningAt: (iso) => {
      lastMiningAt = iso
    },
    ...opts,
  }

  const engine = new ToolEvolutionEngine(deps)
  return { engine, calls, registered, prompts, repo, getLastMiningAt: () => lastMiningAt }
}

beforeEach(() => {
  pendingStore.length = 0
  approvedStore.length = 0
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('runMiningCycle', () => {
  it('完整周期：采集→单次 LLM 草拟→质量门→入队提问', async () => {
    const { engine, calls, prompts } = await makeEngine()
    const summary = await engine.runMiningCycle()

    expect(summary.samplesScanned).toBe(5)
    expect(summary.drafted).toBe(1)
    expect(summary.gatedOut).toBe(0)
    expect(summary.llmCalls).toBe(1)
    expect(calls.length).toBe(1)
    expect(calls[0]).toContain('同一次输出')
    expect(engine.pendingCount).toBe(1)
    expect(prompts.length).toBe(1)
    expect(prompts[0]).toContain('pnpm-build')
    expect(prompts[0]).toContain('启用')
    expect(prompts[0]).toContain('构建指定的 workspace 包')
    expect(prompts[0]).toContain('需要重新构建某个包时')
    expect(prompts[0]).toContain('只想跑测试时不要用')
    expect(prompts[0]).toContain('pnpm --filter {{pkg}} build')
  })

  it('数据不足时静默跳过', async () => {
    const repo = makeRepo()
    const engine = new ToolEvolutionEngine({
      bashCommandRepo: repo,
      callLLM: async () => GOOD_DRAFT_JSON,
      registerEvolvedTool: () => {},
      unregisterTool: () => {},
      getRegisteredToolNames: () => [],
      emitApprovalPrompt: () => {},
      minCountExclusive: 4,
    })
    const summary = await engine.runMiningCycle()
    expect(summary.skippedReason).toContain('不足')
    expect(summary.drafted).toBe(0)
  })

  it('无 count>门槛 的模式时跳过且不调 LLM', async () => {
    const { engine, calls } = await makeEngine({ minCountExclusive: 100 })
    const summary = await engine.runMiningCycle()
    expect(summary.drafted).toBe(0)
    expect(summary.highValuePatterns).toBe(0)
    expect(summary.skippedReason).toMatch(/>100|高频/)
    expect(calls.length).toBe(0)
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

  it('已批准工具的等价模式不再重复草拟（参数名归一比对）', async () => {
    approvedStore.push({
      name: 'pnpm-build',
      description: '构建指定的 workspace 包',
      parameters: { type: 'object', properties: { pkg: { type: 'string' } } },
      commandTemplate: 'pnpm --filter {{pkg}} build',
      isReadOnly: false,
      needsPermission: true,
      status: 'approved',
      samples: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      approvedAt: '2026-01-01T00:00:00.000Z',
    })
    const { engine, prompts } = await makeEngine()
    const summary = await engine.runMiningCycle()
    expect(summary.drafted).toBe(0)
    expect(summary.patternsFound).toBe(1)
    expect(engine.pendingCount).toBe(0)
    expect(prompts.length).toBe(0)
  })

  it('草拟后的 commandTemplate 与已批准工具等价时跳过（不只比 pattern）', async () => {
    approvedStore.push({
      name: 'workspace-package-builder',
      description: '构建指定 workspace 包并可附加额外 flags',
      parameters: {
        type: 'object',
        properties: {
          pkg: { type: 'string' },
          extraFlags: { type: 'string' },
        },
      },
      commandTemplate: 'workspace-package-builder {{pkg}}{{extraFlags}}',
      isReadOnly: false,
      needsPermission: true,
      status: 'approved',
      samples: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      approvedAt: '2026-01-01T00:00:00.000Z',
    })

    const repo = makeRepo()
    const samples = [
      'workspace-package-builder ./apps/windows',
      'workspace-package-builder ./packages/agent-runtime',
      'workspace-package-builder ./apps/windows',
      'workspace-package-builder ./packages/agent-runtime',
      'workspace-package-builder ./apps/windows',
    ]
    for (const command of samples) {
      repo.log({
        agentId: 'agent-1',
        toolCallId: `tc-${Math.random()}`,
        command,
        isError: false,
        durationMs: 100,
      })
    }

    const draftJson = JSON.stringify({
      name: 'workspace-pkg-builder',
      description: '构建指定 workspace 包并可附加额外 flags',
      whenToUse: '需要构建包时',
      whenNotToUse: '只需类型检查时',
      parameters: {
        type: 'object',
        properties: {
          app: { type: 'string', description: '包路径' },
          flags: { type: 'string', description: '额外 flags' },
        },
      },
      commandTemplate: 'workspace-package-builder {{app}}{{flags}}',
      isReadOnly: false,
    })

    const engine = new ToolEvolutionEngine({
      bashCommandRepo: repo,
      callLLM: async () => draftJson,
      registerEvolvedTool: () => {},
      unregisterTool: () => {},
      getRegisteredToolNames: () => ['bash'],
      emitApprovalPrompt: () => {},
      minCountExclusive: 4,
      miningCooldownMs: 0,
    })
    const summary = await engine.runMiningCycle()
    expect(summary.drafted).toBe(0)
    expect(engine.pendingCount).toBe(0)
  })

  it('进 LLM 后写入 lastMiningAt；冷却期内条件检查跳过', async () => {
    let clock = Date.parse('2026-09-11T12:00:00.000Z')
    let lastMiningAt: string | null = null
    const { engine } = await makeEngine({
      miningCooldownMs: WEEK_MS,
      now: () => clock,
      getLastMiningAt: () => lastMiningAt,
      setLastMiningAt: (iso) => {
        lastMiningAt = iso
      },
    })

    const first = await engine.runConditionalCheck()
    expect(first?.drafted).toBe(1)
    expect(lastMiningAt).toBeTruthy()

    clock += 60 * 60 * 1000 // +1h，仍在冷却
    const second = await engine.runConditionalCheck()
    expect(second).toBeNull()
    expect(engine.isInMiningCooldown()).toBe(true)

    clock += WEEK_MS // 冷却结束
    const third = await engine.runConditionalCheck()
    expect(third).not.toBeNull()
  })
})

describe('buildApprovalPrompt', () => {
  it('包含用途、AI 建议、模板与样本', () => {
    const draft: PendingToolDraft = {
      name: 'pnpm-build',
      description: '构建指定的 workspace 包',
      whenToUse: '需要重新构建某个包时',
      whenNotToUse: '只想跑测试时不要用',
      parameters: {
        type: 'object',
        properties: { pkg: { type: 'string', description: '包路径' } },
      },
      commandTemplate: 'pnpm --filter {{pkg}} build',
      isReadOnly: false,
      pattern: 'pnpm --filter {{path}} build',
      samples: [
        'pnpm --filter ./apps/windows build',
        'pnpm --filter ./packages/agent-runtime build',
      ],
      createdAt: '2026-09-11T00:00:00.000Z',
      draftId: 'd1',
    }
    const text = buildApprovalPrompt(draft)
    expect(text).toContain('用途：构建指定的 workspace 包')
    expect(text).toContain('建议使用：需要重新构建某个包时')
    expect(text).toContain('不建议：只想跑测试时不要用')
    expect(text).toContain('pnpm --filter {{pkg}} build')
    expect(text).toContain('pnpm --filter ./apps/windows build')
    expect(text).toContain('启用')
    expect(text).toContain('不用')
  })
})

describe('triggerThreshold（兼容残留）', () => {
  it('clampTriggerThreshold 限制在 10–500', () => {
    expect(clampTriggerThreshold(5)).toBe(10)
    expect(clampTriggerThreshold(50)).toBe(50)
    expect(clampTriggerThreshold(999)).toBe(500)
    expect(clampTriggerThreshold(12.6)).toBe(13)
    expect(clampTriggerThreshold(Number.NaN)).toBe(DEFAULT_TRIGGER_THRESHOLD)
  })

  it('setTriggerThreshold 立即影响 getTriggerThreshold', async () => {
    const { engine } = await makeEngine()
    expect(engine.getTriggerThreshold()).toBe(DEFAULT_TRIGGER_THRESHOLD)
    expect(engine.setTriggerThreshold(20)).toBe(20)
    expect(engine.getTriggerThreshold()).toBe(20)
    expect(engine.setTriggerThreshold(3)).toBe(10)
  })

  it('checkAndTriggerIfNeeded 已弃用，恒为 false', async () => {
    const { engine, repo } = await makeEngine()
    expect(await engine.checkAndTriggerIfNeeded(repo)).toBe(false)
  })
})

describe('canonicalizeParamSlots', () => {
  it('不同参数名归一到同一形态', () => {
    expect(canonicalizeParamSlots('pnpm --filter {{appPath}} build')).toBe('pnpm --filter {{p}} build')
    expect(canonicalizeParamSlots('pnpm --filter {{path}} build')).toBe('pnpm --filter {{p}} build')
    expect(canonicalizeParamSlots('git commit -m {{msg}}')).toBe('git commit -m {{p}}')
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

describe('管理方法（设置页 UI）', () => {
  const approvedDef: Record<string, unknown> = {
    name: 'pnpm-build',
    description: '构建指定的 workspace 包',
    whenToUse: '需要重新构建某个包时',
    whenNotToUse: '只想跑测试时不要用',
    parameters: { type: 'object', properties: { pkg: { type: 'string' } } },
    commandTemplate: 'pnpm --filter {{pkg}} build',
    isReadOnly: false,
    needsPermission: true,
    status: 'approved',
    samples: ['pnpm --filter ./apps/windows build'],
    createdAt: '2026-01-01T00:00:00.000Z',
    approvedAt: '2026-01-01T00:00:00.000Z',
  }

  it('listEvolvedTools 返回已批准与待审批', async () => {
    approvedStore.push(structuredClone({ ...approvedDef, name: 'git-commit', commandTemplate: 'git commit -m {{msg}}' }))
    const { engine } = await makeEngine()
    await engine.runMiningCycle()

    const { tools, pending } = engine.listEvolvedTools()
    expect(tools).toHaveLength(1)
    expect(tools[0]?.name).toBe('git-commit')
    expect(tools[0]?.enabled).toBe(true)
    expect(tools[0]?.sampleCount).toBe(1)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.commandTemplate).toBe('pnpm --filter {{pkg}} build')
    expect(pending[0]?.whenToUse).toBe('需要重新构建某个包时')
    expect(pending[0]?.whenNotToUse).toBe('只想跑测试时不要用')
    expect(pending[0]?.samples?.length).toBeGreaterThan(0)
    expect(pending[0]?.similarApproved).toEqual([])
  })

  it('listEvolvedTools 对待审模板标注疑似重复的已批准工具', async () => {
    approvedStore.push(
      structuredClone({
        ...approvedDef,
        name: 'run-powershell-outputs-script',
        commandTemplate:
          'powershell -NoProfile -ExecutionPolicy Bypass -File outputs\\{{scriptFile}}{{postCommand}}',
      }),
    )
    pendingStore.push({
      name: 'run-outputs-temp-ps1',
      description: '执行 outputs 目录下的临时 PowerShell 脚本',
      whenToUse: '跑临时 ps1',
      whenNotToUse: '已有同类工具时',
      parameters: { type: 'object', properties: {} },
      commandTemplate:
        'powershell -NoProfile -ExecutionPolicy Bypass -File outputs\\{{tmp_script}}{{chained_action}}',
      isReadOnly: false,
      pattern: 'powershell ...',
      samples: ['powershell -NoProfile -ExecutionPolicy Bypass -File outputs\\a.ps1'],
      createdAt: '2026-09-11T00:00:00.000Z',
      draftId: 'd-dup',
    } as never)

    const { engine } = await makeEngine()
    const { pending } = engine.listEvolvedTools()
    expect(pending[0]?.similarApproved).toContain('run-powershell-outputs-script')
  })

  it('listEvolvedTools 对开放式低价值待审标注 lowValueReason', async () => {
    pendingStore.push({
      name: 'run-node-command-chain',
      description: '按参数串联执行最多三个 node 命令',
      whenToUse: '需要连跑 node 时',
      whenNotToUse: '单次调用时',
      parameters: { type: 'object', properties: {} },
      commandTemplate: 'node {{first_node_args}}{{node_chain_1}}{{node_chain_2}}',
      isReadOnly: false,
      pattern: 'node ...',
      samples: ['node a.js'],
      createdAt: '2026-09-11T00:00:00.000Z',
      draftId: 'd-open',
    } as never)

    const { engine } = await makeEngine()
    const { pending } = engine.listEvolvedTools()
    expect(pending[0]?.lowValueReason).toMatch(/解释器|开放/)
  })

  it('setToolEnabled 禁用后 list 反映状态且可重新启用', async () => {
    approvedStore.push(structuredClone(approvedDef))
    const { engine } = await makeEngine()

    expect(engine.setToolEnabled('pnpm-build', false)).toBe(true)
    expect(engine.listEvolvedTools().tools[0]?.enabled).toBe(false)

    expect(engine.setToolEnabled('pnpm-build', true)).toBe(true)
    expect(engine.listEvolvedTools().tools[0]?.enabled).toBe(true)
  })

  it('setToolEnabled / removeTool 对不存在工具返回 false', async () => {
    const { engine } = await makeEngine()
    expect(engine.setToolEnabled('nope', true)).toBe(false)
    expect(engine.removeTool('nope')).toBe(false)
  })

  it('removeTool 删除后 list 为空', async () => {
    approvedStore.push(structuredClone(approvedDef))
    const { engine } = await makeEngine()
    expect(engine.removeTool('pnpm-build')).toBe(true)
    expect(engine.listEvolvedTools().tools).toHaveLength(0)
  })

  it('consumePending 按名确认/拒绝（设置页按钮路径）', async () => {
    const { engine, registered } = await makeEngine()
    await engine.runMiningCycle()
    expect(engine.pendingCount).toBe(1)

    expect(await engine.consumePending('pnpm-build', true)).toBe(true)
    expect(registered).toEqual(['pnpm-build'])
    expect(engine.pendingCount).toBe(0)

    expect(await engine.consumePending('ghost', true)).toBe(false)
  })
})
