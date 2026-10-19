/**
 * deliverSubagentCompletion 单测：running / idle / 其他状态三分支
 */

import { describe, it, expect, vi } from 'vitest'
import { deliverSubagentCompletion } from './subagent-delivery'
import type { AgentInstance } from '@mtbot/agent-runtime'
import type { SubagentCompletionPayload } from '@mtbot/agent-runtime'

const payload: SubagentCompletionPayload = {
  childId: 'child-1',
  parentId: 'parent-1',
  name: 'explore',
  status: 'succeeded',
  summary: 'found stuff',
}

const format = (p: SubagentCompletionPayload) =>
  `[SUBAGENT_COMPLETE]\nname: ${p.name}\ninstanceId: ${p.childId}\nstatus: ${p.status}\nsummary:\n${p.summary}`

/** 构造可切换 state 的父实例 mock */
function mockParent(state: string): AgentInstance & {
  followUp: ReturnType<typeof vi.fn>
  prompt: ReturnType<typeof vi.fn>
} {
  return {
    state,
    followUp: vi.fn(),
    prompt: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentInstance & {
    followUp: ReturnType<typeof vi.fn>
    prompt: ReturnType<typeof vi.fn>
  }
}

describe('deliverSubagentCompletion', () => {
  it('parent running → followUp', async () => {
    const parent = mockParent('running')
    const mode = await deliverSubagentCompletion({ parent, payload, format })
    expect(mode).toBe('followUp')
    expect(parent.followUp).toHaveBeenCalledTimes(1)
    expect(parent.followUp).toHaveBeenCalledWith(expect.stringContaining('[SUBAGENT_COMPLETE]'))
    expect(parent.prompt).not.toHaveBeenCalled()
  })

  it('parent idle → prompt(origin=internal)', async () => {
    const parent = mockParent('idle')
    const mode = await deliverSubagentCompletion({ parent, payload, format })
    expect(mode).toBe('prompt')
    expect(parent.prompt).toHaveBeenCalledWith(
      expect.stringContaining('[SUBAGENT_COMPLETE]'),
      undefined,
      'internal',
    )
    expect(parent.followUp).not.toHaveBeenCalled()
  })

  it('idle 开新回合前先准备归属起点（清登记 + 快照），running 不重复准备', async () => {
    const idleParent = mockParent('idle')
    const before = vi.fn().mockResolvedValue(undefined)
    await deliverSubagentCompletion({ parent: idleParent, payload, format, beforeInternalPrompt: before })
    expect(before).toHaveBeenCalledTimes(1)
    expect(idleParent.prompt).toHaveBeenCalledTimes(1)

    const runningParent = mockParent('running')
    const beforeRunning = vi.fn().mockResolvedValue(undefined)
    await deliverSubagentCompletion({
      parent: runningParent,
      payload,
      format,
      beforeInternalPrompt: beforeRunning,
    })
    // running 走 followUp，沿用父回合已开的快照，不能再重置登记表
    expect(beforeRunning).not.toHaveBeenCalled()
  })

  it('起点准备抛错不阻断完成通知', async () => {
    const parent = mockParent('idle')
    const before = vi.fn().mockRejectedValue(new Error('snapshot failed'))
    const mode = await deliverSubagentCompletion({
      parent,
      payload,
      format,
      beforeInternalPrompt: before,
    })
    expect(mode).toBe('prompt')
    expect(parent.prompt).toHaveBeenCalledWith(
      expect.stringContaining('[SUBAGENT_COMPLETE]'),
      undefined,
      'internal',
    )
  })

  it('parent paused/error/aborted → deferred', async () => {
    for (const state of ['paused', 'error', 'aborted'] as const) {
      const parent = mockParent(state)
      const mode = await deliverSubagentCompletion({ parent, payload, format })
      expect(mode).toBe('deferred')
      expect(parent.followUp).not.toHaveBeenCalled()
      expect(parent.prompt).not.toHaveBeenCalled()
    }
  })
})
