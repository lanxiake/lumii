import { describe, expect, it } from 'vitest'
import { resolvePipelineAgentWhitelist } from './pipeline-agent-whitelist'

describe('resolvePipelineAgentWhitelist', () => {
  it('未给白名单 → 从父工具集里扣掉四个危险名', () => {
    const got = resolvePipelineAgentWhitelist(
      ['bash', 'spawn_agent', 'send_message', 'pipeline_run', 'ask_user_question', 'file_read'],
      undefined,
    )
    expect(got).toEqual(['bash', 'file_read'])
  })

  /**
   * `ask_user_question` 必须去掉：流水线无人值守，子 Agent 一问就挂在那里等一个不会来的
   * 回答。2026-11-03 真机：红队步发现目标没起服务后调它，会话锁从 120s 堆到 360s+，
   * 整条 run 卡死。缺信息时应当如实失败，让调用方看 journal 补前置条件。
   */
  it('去掉 ask_user_question（无人值守，问了没人答）', () => {
    expect(resolvePipelineAgentWhitelist(['bash'], ['ask_user_question'])).toEqual([])
  })

  it('显式白名单同样清洗（用户写漏了不该炸整条 run）', () => {
    expect(resolvePipelineAgentWhitelist(['bash'], ['file_read', 'send_message'])).toEqual([
      'file_read',
    ])
  })

  it('父工具集没有危险名时原样返回', () => {
    expect(resolvePipelineAgentWhitelist(['bash', 'file_read'], undefined)).toEqual([
      'bash',
      'file_read',
    ])
  })

  it('显式空数组等于「不限制」，不会被误判成「给个空名单」', () => {
    // orchestrator 对空数组的处理是「不限制」，所以我们如实返回空数组由调用方决定
    expect(resolvePipelineAgentWhitelist(['bash'], [])).toEqual([])
  })
})
