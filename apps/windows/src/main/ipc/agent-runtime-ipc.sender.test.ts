// @vitest-environment node
/**
 * `agent-runtime:command` 的来源校验。
 *
 * 背景：这条 IPC 是渲染层总入口，可达 `files:delete` / `conversation:delete` /
 * `storage:deleteBackup`，而模型生成的 HTML 产物就跑在同一个应用里（webview / iframe）。
 * 校验一旦失效，一条被提示注入的产物页就能直接发命令。
 */
import { describe, expect, it } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'

import { isTrustedCommandSender } from './agent-runtime-ipc'

/** 造一个只带校验所需字段的假事件 */
function makeEvent(opts: {
  sameFrame?: boolean
  type?: string
  hasFrame?: boolean
}): IpcMainInvokeEvent {
  const mainFrame = { id: 'main-frame' }
  const sender = {
    mainFrame,
    getType: () => opts.type ?? 'window',
  }
  return {
    senderFrame: opts.hasFrame === false ? null : opts.sameFrame === false ? { id: 'child-frame' } : mainFrame,
    sender,
  } as unknown as IpcMainInvokeEvent
}

describe('isTrustedCommandSender', () => {
  it('主窗口主框架放行', () => {
    expect(isTrustedCommandSender(makeEvent({}))).toBe(true)
  })

  it('同 WebContents 的子 iframe 拒绝', () => {
    expect(isTrustedCommandSender(makeEvent({ sameFrame: false }))).toBe(false)
  })

  it('webview 拒绝（独立 WebContents，主框架也算"主框架"，必须按类型挡）', () => {
    expect(isTrustedCommandSender(makeEvent({ type: 'webview' }))).toBe(false)
  })

  it('browserView 拒绝', () => {
    expect(isTrustedCommandSender(makeEvent({ type: 'browserView' }))).toBe(false)
  })

  it('拿不到 senderFrame 时拒绝（默认拒绝，不默认放行）', () => {
    expect(isTrustedCommandSender(makeEvent({ hasFrame: false }))).toBe(false)
  })

  it('getType 抛错时拒绝', () => {
    const event = {
      senderFrame: { id: 'f' },
      sender: {
        mainFrame: { id: 'f' },
        getType: () => {
          throw new Error('destroyed')
        },
      },
    } as unknown as IpcMainInvokeEvent
    expect(isTrustedCommandSender(event)).toBe(false)
  })
})
