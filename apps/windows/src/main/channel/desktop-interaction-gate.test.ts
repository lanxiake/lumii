/**
 * 桌面弹窗门控：渠道已文字化承接时，客户端不得再弹审批/询问窗。
 */

import { describe, it, expect } from 'vitest'
import {
  canChannelHandleQuestions,
  resolveAskUserDelivery,
  resolvePermissionDelivery,
} from './desktop-interaction-gate'

describe('resolveAskUserDelivery', () => {
  it('渠道已承接时仅走渠道，不向客户端弹 AskUserModal', () => {
    expect(resolveAskUserDelivery(true)).toBe('channel-only')
  })

  it('渠道未承接时走桌面弹窗', () => {
    expect(resolveAskUserDelivery(false)).toBe('desktop')
  })
})

describe('resolvePermissionDelivery', () => {
  it('自动审批开启时主进程直接放行，不依赖弹窗', () => {
    expect(
      resolvePermissionDelivery({
        autoApprove: true,
        channelHandled: false,
        ipcAvailable: true,
      }),
    ).toBe('auto-approve')
  })

  it('人工审批且渠道已承接时仅走渠道文字审批，不弹客户端审批卡', () => {
    expect(
      resolvePermissionDelivery({
        autoApprove: false,
        channelHandled: true,
        ipcAvailable: true,
      }),
    ).toBe('channel-only')
  })

  it('人工审批且渠道未承接、IPC 可用时走桌面审批卡', () => {
    expect(
      resolvePermissionDelivery({
        autoApprove: false,
        channelHandled: false,
        ipcAvailable: true,
      }),
    ).toBe('desktop-ipc')
  })

  it('人工审批且渠道与 IPC 皆不可用时回退 native dialog', () => {
    expect(
      resolvePermissionDelivery({
        autoApprove: false,
        channelHandled: false,
        ipcAvailable: false,
      }),
    ).toBe('desktop-native')
  })

  it('自动审批优先于渠道承接（避免重复推 IM 审批噪音）', () => {
    expect(
      resolvePermissionDelivery({
        autoApprove: true,
        channelHandled: true,
        ipcAvailable: true,
      }),
    ).toBe('auto-approve')
  })
})

describe('canChannelHandleQuestions（§5.5 交互降级）', () => {
  const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `选项${i + 1}` }))

  it('≤3 个单选选项渠道可承载', () => {
    expect(canChannelHandleQuestions([{ options: opts(3) }])).toBe(true)
  })

  it('>3 个选项超出纯文字可读范围，回客户端', () => {
    expect(canChannelHandleQuestions([{ options: opts(4) }])).toBe(false)
  })

  it('多选要求用户拼序号，易错，回客户端', () => {
    expect(canChannelHandleQuestions([{ options: opts(2), multiSelect: true }])).toBe(false)
  })

  it('多问题里只要有一个超限就整体降级', () => {
    expect(
      canChannelHandleQuestions([{ options: opts(2) }, { options: opts(5) }]),
    ).toBe(false)
  })

  it('空问题列表按可承载处理（不误降级）', () => {
    expect(canChannelHandleQuestions([])).toBe(true)
  })
})
