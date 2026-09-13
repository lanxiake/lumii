/**
 * 转交完成汇报的桌面通知：用户不在原会话时补通知（点击直达），在原会话时不打扰。
 */
import { describe, expect, it, vi } from 'vitest'
import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import { reportToOriginSession } from './handoff-commands'

function makeBridge(lastActiveConvId: string | null) {
  return {
    conversationRepo: { saveMessage: () => 'msg-1' },
    forwardIpcEvent: vi.fn(),
    getLastActiveConversationId: () => lastActiveConvId,
    triggerCronNotification: vi.fn(),
  } as unknown as AgentRuntimeBridge
}

const OK_REPORT = { ok: true, devSessionKey: 'dev-1', devSessionTitle: '开发会话', text: '已完成改造' }

describe('reportToOriginSession', () => {
  it('用户不在原会话时弹完成通知，点击跳回原会话', () => {
    const bridge = makeBridge('other-conv')
    reportToOriginSession(bridge, 'origin-conv', '修复登录页 bug', OK_REPORT)
    expect(bridge.triggerCronNotification).toHaveBeenCalledWith(
      'Lumii · 转交完成',
      expect.stringContaining('修复登录页 bug'),
      'origin-conv',
    )
  })

  it('用户正在原会话时不弹（结果消息已实时可见）', () => {
    const bridge = makeBridge('origin-conv')
    reportToOriginSession(bridge, 'origin-conv', '修复登录页 bug', OK_REPORT)
    expect(bridge.triggerCronNotification).not.toHaveBeenCalled()
  })

  it('失败汇报带失败原因', () => {
    const bridge = makeBridge(null)
    reportToOriginSession(bridge, 'origin-conv', '修复登录页 bug', {
      ok: false,
      devSessionKey: 'dev-1',
      text: '等待开发任务完成超时（90 分钟）',
    })
    expect(bridge.triggerCronNotification).toHaveBeenCalledWith(
      'Lumii · 转交失败',
      expect.stringContaining('等待开发任务完成超时'),
      'origin-conv',
    )
  })
})
