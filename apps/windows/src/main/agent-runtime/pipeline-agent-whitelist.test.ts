import { describe, expect, it } from 'vitest'
import { resolvePipelineAgentWhitelist } from './pipeline-agent-whitelist'

describe('resolvePipelineAgentWhitelist', () => {
  it('未给白名单 → 从父工具集里扣掉三个危险名', () => {
    const got = resolvePipelineAgentWhitelist(
      ['bash', 'spawn_agent', 'send_message', 'pipeline_run', 'file_read'],
      undefined,
    )
    expect(got).toEqual(['bash', 'file_read'])
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
