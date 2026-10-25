/**
 * 桌面交互门控：渠道文字与桌面消息卡可双投递；代聊无人可答。
 */

import { describe, it, expect } from 'vitest'
import {
  canChannelHandleQuestions,
  resolveAskUserDelivery,
  resolvePermissionDelivery,
} from './desktop-interaction-gate'

describe('resolveAskUserDelivery', () => {
  it('渠道已承接时双投递（文字 + 桌面消息卡）', () => {
    expect(resolveAskUserDelivery(true)).toBe('channel-and-desktop')
  })

  it('渠道未承接时仅走桌面消息卡', () => {
    expect(resolveAskUserDelivery(false)).toBe('desktop')
  })

  it('代聊会话（本机微信）里没人可答 —— 渠道与桌面都不投，由调用方立即收口', () => {
    // 实测 2026-10-09 14:42：代聊回合问了句配置问题，两个投递面都够不着，
    // waitForAnswer 挂满 10 分钟，把 wechat-watch 整条回路堵死。
    expect(resolveAskUserDelivery(false, true)).toBe('none')
    // 即便"渠道已承接"也是 none：代聊会话的另一头是好友，推出去就是发给好友
    expect(resolveAskUserDelivery(true, true)).toBe('none')
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

  it('人工审批且渠道已承接、IPC 可用时双投递', () => {
    expect(
      resolvePermissionDelivery({
        autoApprove: false,
        channelHandled: true,
        ipcAvailable: true,
      }),
    ).toBe('channel-and-desktop')
  })

  it('人工审批且渠道已承接、IPC 不可用时仅渠道文字', () => {
    expect(
      resolvePermissionDelivery({
        autoApprove: false,
        channelHandled: true,
        ipcAvailable: false,
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

describe('canChannelHandleQuestions（渠道一律文字化）', () => {
  const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `选项${i + 1}` }))

  it('≤3 个单选选项可承载', () => {
    expect(canChannelHandleQuestions([{ options: opts(3) }])).toBe(true)
  })

  it('>3 个选项也走渠道文字（编号列表），不再降级回客户端', () => {
    expect(canChannelHandleQuestions([{ options: opts(4) }])).toBe(true)
  })

  it('多选也走渠道文字（逗号分隔序号）', () => {
    expect(canChannelHandleQuestions([{ options: opts(2), multiSelect: true }])).toBe(true)
  })

  it('多问题组合均可承载', () => {
    expect(
      canChannelHandleQuestions([{ options: opts(2) }, { options: opts(5), multiSelect: true }]),
    ).toBe(true)
  })

  it('空问题列表按可承载处理（不误降级）', () => {
    expect(canChannelHandleQuestions([])).toBe(true)
  })
})
