/**
 * 桌面弹窗门控：渠道已文字化承接时，客户端不得再弹审批/询问窗。
 */

import { describe, it, expect } from 'vitest'
import {
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
