/**
 * resolveChannelFromSessionKey 单元测试
 *
 * 定时任务创建时，若 Agent 未显式指定 notify_targets，用当前对话所在渠道
 * 兜底（bridge-tool-registrar.ts 的 cron_create execute 覆盖里调用）。
 * 微信/企微没有主动推送能力（被动回复模式），回落系统通知；只有飞书能主动推送。
 */
import { describe, expect, it } from 'vitest'
import { resolveChannelFromSessionKey } from './bridge-tool-registrar'

describe('resolveChannelFromSessionKey', () => {
  it('飞书 sessionKey 前缀 → feishu', () => {
    expect(resolveChannelFromSessionKey('feishu:ou_abc123')).toBe('feishu')
    expect(resolveChannelFromSessionKey('feishu:ou_abc123:1234567890')).toBe('feishu')
  })

  it('微信 sessionKey 前缀 → 回落 system（无主动推送能力）', () => {
    expect(resolveChannelFromSessionKey('weixin:user123')).toBe('system')
  })

  it('企微 sessionKey 前缀 → 回落 system（无主动推送能力）', () => {
    expect(resolveChannelFromSessionKey('wecom:user123:1234567890')).toBe('system')
  })

  it('无前缀（IPC 本地对话）→ system', () => {
    expect(resolveChannelFromSessionKey('a1b2c3d4e5f6')).toBe('system')
  })

  it('undefined（拿不到 sessionKey）→ system', () => {
    expect(resolveChannelFromSessionKey(undefined)).toBe('system')
  })
})
