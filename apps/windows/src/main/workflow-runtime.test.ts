import { describe, expect, it } from 'vitest'
import {
  hasWorkflow,
  handleWorkflowInstruction,
  registerWorkflow,
  workflowInstruction,
} from './workflow-runtime'

describe('workflow-runtime', () => {
  it('路由规范化工作流指令并返回运行摘要', async () => {
    registerWorkflow('test-feed-route', async () => ({ summary: '测试工作流已完成' }))
    expect(hasWorkflow('test-feed-route')).toBe(true)

    await expect(
      handleWorkflowInstruction(workflowInstruction('test-feed-route')),
    ).resolves.toBe('测试工作流已完成')
  })

  it('普通 cron 文本不被误判为工作流', async () => {
    await expect(handleWorkflowInstruction('下午三点提醒我开会')).resolves.toBeNull()
  })

  it('未注册的工作流明确失败，不静默退化成系统提醒', async () => {
    await expect(
      handleWorkflowInstruction(workflowInstruction('missing-feed-route')),
    ).rejects.toThrow('未注册的本地工作流')
  })
})
