/**
 * event-converter 回归保护
 *
 * 背景：同步抛错（未配置 API Key / 模型未启用）时，pi-agent-core 不会抛异常，
 * 而是把错误吞成 agent:end（经 mapAgentEvent 挂上 error 字段）。若 converter 不把它
 * 转成 agent:error，桌面端渲染进程收不到错误提示，表现为「发完消息毫无反应」。
 */

import { describe, expect, it } from 'vitest'
import { convertOldEventToIpcEvents, createRunContext } from './event-converter'
import type { AgentRuntimeEvent as OldEvent } from '@mtbot/agent-runtime'

const INSTANCE_ID = 'instance-1'
const SESSION_KEY = 'conversation-1'

describe('convertOldEventToIpcEvents agent:end', () => {
  it('同步抛错（带 error）转成 agent:error，让渲染进程弹 toast', () => {
    const ctx = createRunContext(SESSION_KEY, INSTANCE_ID, SESSION_KEY)
    const oldEvent = {
      type: 'agent:end',
      instanceId: INSTANCE_ID,
      error: '请先在设置中填写文本对话模型的 API Key',
    } as OldEvent

    const events = convertOldEventToIpcEvents(oldEvent, ctx)
    expect(events).toEqual([
      expect.objectContaining({
        type: 'agent:error',
        errorCode: 'AGENT_ERROR',
        errorMessage: '请先在设置中填写文本对话模型的 API Key',
        isRetryable: false,
      }),
    ])
  })

  it('正常结束（无 error）转成 turn:end + idle', () => {
    const ctx = createRunContext(SESSION_KEY, INSTANCE_ID, SESSION_KEY)
    const oldEvent = { type: 'agent:end', instanceId: INSTANCE_ID } as OldEvent

    const events = convertOldEventToIpcEvents(oldEvent, ctx)
    expect(events.map((e) => e.type)).toEqual(['agent:turn:end', 'agent:idle'])
  })
})
