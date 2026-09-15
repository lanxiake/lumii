/**
 * 渠道身份（10-S2）：归属解析的唯一来源。
 *
 * 要点：**落库值优先，前缀只作回退**——前缀说明会话从哪来，不说明此刻谁在说话
 * （同一 qbot: 键会被微信适配器服务，见 10 号计划 §2.1）。
 */

import { describe, expect, it } from 'vitest'
import {
  channelLabelOfOwnership,
  channelOwnershipFromKey,
  isChannelOwnership,
  isSystemOwnership,
  resolveChannelIdentity,
  SYSTEM_OWNERSHIPS,
} from './channel-identity'

describe('channelOwnershipFromKey（迁移期回退）', () => {
  it('渠道前缀 → 对应归属', () => {
    expect(channelOwnershipFromKey('weixin:u1')).toBe('weixin')
    expect(channelOwnershipFromKey('feishu:ou_x')).toBe('feishu')
    expect(channelOwnershipFromKey('wecom:u1')).toBe('wecom')
    expect(channelOwnershipFromKey('qbot:964A')).toBe('qbot')
  })

  it('带时间戳的 /new 键同样识别', () => {
    expect(channelOwnershipFromKey('qbot:964A:1730000000000')).toBe('qbot')
  })

  it('系统会话前缀', () => {
    expect(channelOwnershipFromKey('cron:daily')).toBe('cron')
    expect(channelOwnershipFromKey('evolution:main')).toBe('evolution')
    expect(channelOwnershipFromKey('onboarding:guide')).toBe('onboarding')
  })

  it('裸 conversationId（客户端会话）→ ipc', () => {
    expect(channelOwnershipFromKey('1f3c9a2b')).toBe('ipc')
    expect(channelOwnershipFromKey('conversation-1')).toBe('ipc')
  })
})

describe('resolveChannelIdentity（落库值优先）', () => {
  it('落库值覆盖前缀推断', () => {
    // 前缀说是微信，落库说是 QQ —— 信落库（S2 的核心约定）
    expect(resolveChannelIdentity('weixin:u1', 'qbot')).toEqual({ ownership: 'qbot', label: 'QQ' })
  })

  it('落库值缺失（老库未回填 / 新会话）→ 回退前缀', () => {
    expect(resolveChannelIdentity('weixin:u1', null)).toEqual({
      ownership: 'weixin',
      label: '微信',
    })
    expect(resolveChannelIdentity('abc123')).toEqual({ ownership: 'ipc', label: '客户端' })
  })

  it('落库值脏（未知字符串）→ 回退前缀，不污染判定', () => {
    expect(resolveChannelIdentity('qbot:964A', 'telegram').ownership).toBe('qbot')
    expect(resolveChannelIdentity('qbot:964A', '').ownership).toBe('qbot')
    expect(resolveChannelIdentity('qbot:964A', 42 as unknown as string).ownership).toBe('qbot')
  })
})

describe('标签与系统归属', () => {
  it('渠道有中文名，客户端是「客户端」，系统会话无标签', () => {
    expect(channelLabelOfOwnership('weixin')).toBe('微信')
    expect(channelLabelOfOwnership('qbot')).toBe('QQ')
    expect(channelLabelOfOwnership('ipc')).toBe('客户端')
    // 空标签是既有消费方（/resume 列表、接续候选）排除系统会话的判据，不能改成「系统」
    expect(channelLabelOfOwnership('cron')).toBe('')
    expect(channelLabelOfOwnership('evolution')).toBe('')
    expect(channelLabelOfOwnership('onboarding')).toBe('')
  })

  it('系统归属集合含 onboarding（07 向导会话的守卫前提）', () => {
    expect(SYSTEM_OWNERSHIPS.has('onboarding')).toBe(true)
    expect(isSystemOwnership('cron')).toBe(true)
    expect(isSystemOwnership('weixin')).toBe(false)
    expect(isSystemOwnership('ipc')).toBe(false)
  })

  it('isChannelOwnership 只认登记过的值', () => {
    expect(isChannelOwnership('qbot')).toBe(true)
    expect(isChannelOwnership('ipc')).toBe(true)
    expect(isChannelOwnership('onboarding')).toBe(true)
    expect(isChannelOwnership('telegram')).toBe(false)
    expect(isChannelOwnership(null)).toBe(false)
    expect(isChannelOwnership(undefined)).toBe(false)
  })
})
