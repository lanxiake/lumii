/**
 * 转交完成汇报的两条出口（并存，不是二选一）：
 * - 渠道会话（QQ / 飞书 / 微信 / 企微）→ 推到渠道；那里的用户看不到开发会话，只落库等于没响应
 * - 桌面 → 用户不在原会话时补通知（点击直达），在原会话时不打扰
 */
import { describe, expect, it, vi } from 'vitest'
import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import { reportToOriginSession } from './handoff-commands'

function makeBridge(lastActiveConvId: string | null, pushedToChannel = false) {
  return {
    conversationRepo: { saveMessage: () => 'msg-1' },
    forwardIpcEvent: vi.fn(),
    getLastActiveConversationId: () => lastActiveConvId,
    triggerCronNotification: vi.fn(),
    pushChannelText: vi.fn(async () => pushedToChannel),
  } as unknown as AgentRuntimeBridge
}

const OK_REPORT = { ok: true, devSessionKey: 'dev-1', devSessionTitle: '开发会话', text: '已完成改造' }

describe('reportToOriginSession', () => {
  it('用户不在原会话时弹完成通知，点击跳回原会话', async () => {
    const bridge = makeBridge('other-conv')
    await reportToOriginSession(bridge, 'origin-conv', '修复登录页 bug', OK_REPORT)
    expect(bridge.triggerCronNotification).toHaveBeenCalledWith(
      'Lumii · 转交完成',
      expect.stringContaining('修复登录页 bug'),
      'origin-conv',
    )
  })

  it('用户正在原会话时不弹（结果消息已实时可见）', async () => {
    const bridge = makeBridge('origin-conv')
    await reportToOriginSession(bridge, 'origin-conv', '修复登录页 bug', OK_REPORT)
    expect(bridge.triggerCronNotification).not.toHaveBeenCalled()
  })

  it('失败汇报带失败原因', async () => {
    const bridge = makeBridge(null)
    await reportToOriginSession(bridge, 'origin-conv', '修复登录页 bug', {
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

  it('渠道会话：结果推到渠道（渠道用户看不到开发会话，只落库等于没响应）', async () => {
    const bridge = makeBridge('other-conv', true)
    await reportToOriginSession(bridge, 'qbot:u-1', '修复登录页 bug', OK_REPORT)

    expect(bridge.pushChannelText).toHaveBeenCalledWith(
      'qbot:u-1',
      expect.stringContaining('已完成改造'),
    )
  })

  it('渠道推送失败（应用重启后无回复上下文）→ 桌面通知仍在，结果不静默丢失', async () => {
    const bridge = makeBridge('other-conv', false)
    await reportToOriginSession(bridge, 'qbot:u-1', '修复登录页 bug', OK_REPORT)

    expect(bridge.triggerCronNotification).toHaveBeenCalled()
  })

  it('桌面会话也走一次渠道推送（会话不在渠道上时返回 false，桌面路径不受影响）', async () => {
    const bridge = makeBridge('origin-conv')
    await reportToOriginSession(bridge, 'origin-conv', '修复登录页 bug', OK_REPORT)

    expect(bridge.pushChannelText).toHaveBeenCalledWith('origin-conv', expect.any(String))
    expect(bridge.triggerCronNotification).not.toHaveBeenCalled()
  })
})
