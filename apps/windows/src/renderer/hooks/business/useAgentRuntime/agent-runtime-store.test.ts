/**
 * agent-runtime-store 辅助函数单元测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  findAnyPendingPermission,
  getDefaultPerSessionState,
  getPendingPermissionSnapshot,
  resetRuntimeStore,
  runtimeStore,
  type PendingPermission,
} from './agent-runtime-store'
import {
  handleRuntimeEvent,
  resetAgentRuntimeEventHandlerForTests,
} from './event-handler'

describe('findAnyPendingPermission', () => {
  beforeEach(() => {
    resetRuntimeStore()
  })

  it('无待处理权限时返回 null', () => {
    expect(findAnyPendingPermission(runtimeStore.getState())).toBeNull()
  })

  it('应找到非当前会话中的待处理权限', () => {
    const pending: PendingPermission = {
      requestId: 'req-1',
      toolName: 'file_write',
      toolArgs: { path: 'a.md' },
      riskLevel: 'medium',
      description: 'write file',
      timeoutMs: 30_000,
      receivedAt: Date.now(),
    }
    runtimeStore.setState((prev) => {
      const sessions = new Map(prev.sessions)
      sessions.set('weixin:foo@im.wechat', {
        ...getDefaultPerSessionState(),
        pendingPermission: pending,
      })
      return { ...prev, currentSessionKey: 'local:other', sessions }
    })

    const found = findAnyPendingPermission(runtimeStore.getState())
    expect(found).toEqual({ sessionKey: 'weixin:foo@im.wechat', pending })
  })

  it('getPendingPermissionSnapshot 在无权限时返回稳定引用', () => {
    const a = getPendingPermissionSnapshot()
    const b = getPendingPermissionSnapshot()
    expect(a).toBe(b)
    expect(a.pending).toBeNull()
  })

  it('getPendingPermissionSnapshot 在权限未变时返回稳定引用', () => {
    const pending: PendingPermission = {
      requestId: 'req-2',
      toolName: 'bash',
      toolArgs: {},
      riskLevel: 'high',
      description: 'run cmd',
      timeoutMs: 30_000,
      receivedAt: Date.now(),
    }
    runtimeStore.setState((prev) => {
      const sessions = new Map(prev.sessions)
      sessions.set('local:a', { ...getDefaultPerSessionState(), pendingPermission: pending })
      return { ...prev, sessions }
    })
    const a = getPendingPermissionSnapshot()
    const b = getPendingPermissionSnapshot()
    expect(a).toBe(b)
    expect(a.pending?.requestId).toBe('req-2')
  })
})

describe('handleRuntimeEvent assistant parts', () => {
  beforeEach(() => {
    resetRuntimeStore()
    resetAgentRuntimeEventHandlerForTests()
    vi.stubGlobal('requestAnimationFrame', () => 1)
    runtimeStore.setState((prev) => ({
      ...prev,
      currentSessionKey: 'session-1',
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /**
   * 创建主 Agent 流式消息，供 parts 事件归约测试复用。
   */
  function startAssistantMessage(): void {
    handleRuntimeEvent({
      type: 'agent:message:start',
      runId: 'run-1',
      sessionKey: 'session-1',
      messageId: 'message-1',
      model: 'test-model',
      timestamp: 100,
    })
  }

  it('按 thinking、tool、text 的事件顺序生成并在 idle 收尾 parts', () => {
    startAssistantMessage()

    handleRuntimeEvent({
      type: 'agent:thinking:delta',
      runId: 'run-1',
      sessionKey: 'session-1',
      delta: '分析中',
    })
    handleRuntimeEvent({
      type: 'agent:tool:start',
      runId: 'run-1',
      toolCallId: 'tool-1',
      toolName: 'file_read',
      args: { path: 'README.md' },
      timestamp: 110,
    })
    handleRuntimeEvent({
      type: 'agent:message:delta',
      runId: 'run-1',
      sessionKey: 'session-1',
      messageId: 'message-1',
      delta: '完成',
      totalLength: 2,
    })
    handleRuntimeEvent({
      type: 'agent:idle',
      runId: 'run-1',
      sessionKey: 'session-1',
    })

    const message = runtimeStore.getState().sessions.get('session-1')?.messages[0]
    expect(message?.parts).toEqual([
      expect.objectContaining({ type: 'thinking', text: '分析中', status: 'done' }),
      expect.objectContaining({
        type: 'tool',
        id: 'tool-1',
        name: 'file_read',
        status: 'running',
      }),
      expect.objectContaining({ type: 'text', text: '完成', status: 'done' }),
    ])
  })

  it('同一批次内按 text、thinking 的到达顺序生成 parts', () => {
    startAssistantMessage()

    handleRuntimeEvent({
      type: 'agent:message:delta',
      runId: 'run-1',
      sessionKey: 'session-1',
      messageId: 'message-1',
      delta: '先回答',
      totalLength: 3,
    })
    handleRuntimeEvent({
      type: 'agent:thinking:delta',
      runId: 'run-1',
      sessionKey: 'session-1',
      delta: '后思考',
    })
    handleRuntimeEvent({
      type: 'agent:idle',
      runId: 'run-1',
      sessionKey: 'session-1',
    })

    const message = runtimeStore.getState().sessions.get('session-1')?.messages[0]
    expect(message?.parts).toEqual([
      expect.objectContaining({ type: 'text', text: '先回答', status: 'done' }),
      expect.objectContaining({ type: 'thinking', text: '后思考', status: 'done' }),
    ])
  })

  it('主 Agent LLM 错误应同时写入 content 与 parts', () => {
    startAssistantMessage()

    handleRuntimeEvent({
      type: 'agent:message:end',
      runId: 'run-1',
      sessionKey: 'session-1',
      messageId: 'message-1',
      content: [{ type: 'text', text: '' }],
      usage: { inputTokens: 1, outputTokens: 0 },
      stopReason: 'error',
      llmError: {
        code: 'insufficient_balance',
        message: '余额不足',
        retryable: false,
      },
    })

    const message = runtimeStore.getState().sessions.get('session-1')?.messages[0]
    expect(message?.content[0]?.text).toBe('[insufficient_balance] 余额不足')
    expect(message?.parts).toContainEqual(expect.objectContaining({
      type: 'text',
      text: '[insufficient_balance] 余额不足',
      status: 'done',
    }))
  })

  it('子 Agent LLM 错误应同时写入 content 与 parts', () => {
    handleRuntimeEvent({
      type: 'agent:message:start',
      runId: 'run-1',
      sessionKey: 'sub-session-1',
      rootSessionKey: 'session-1',
      instanceId: 'sub-agent-1',
      messageId: 'sub-message-1',
      model: 'test-model',
      timestamp: 100,
    })

    handleRuntimeEvent({
      type: 'agent:message:end',
      runId: 'run-1',
      sessionKey: 'sub-session-1',
      rootSessionKey: 'session-1',
      instanceId: 'sub-agent-1',
      messageId: 'sub-message-1',
      content: [{ type: 'text', text: '' }],
      usage: { inputTokens: 1, outputTokens: 0 },
      stopReason: 'error',
      llmError: {
        code: 'provider_error',
        message: '服务暂不可用',
        retryable: true,
      },
    })

    const message = runtimeStore.getState().sessions.get('session-1')?.messages[0]
    expect(message?.content[0]?.text).toBe('[provider_error] 服务暂不可用')
    expect(message?.parts).toContainEqual(expect.objectContaining({
      type: 'text',
      text: '[provider_error] 服务暂不可用',
      status: 'done',
    }))
  })

  it('将回合文件变更写入事件指定的 assistant 消息', () => {
    startAssistantMessage()
    const fileChanges = [
      { path: 'src/new.ts', status: 'added' as const },
      { path: 'src/old.ts', status: 'deleted' as const },
    ]

    handleRuntimeEvent({
      type: 'agent:turn:file-changes',
      runId: 'run-1',
      sessionKey: 'session-1',
      messageId: 'message-1',
      fileChanges,
    })

    const message = runtimeStore.getState().sessions.get('session-1')?.messages[0]
    expect(message?.fileChanges).toEqual(fileChanges)
  })

  it('主 Agent tool:end 应完成对应工具 part', () => {
    startAssistantMessage()
    handleRuntimeEvent({
      type: 'agent:tool:start',
      runId: 'run-1',
      toolCallId: 'tool-1',
      toolName: 'file_read',
      args: { path: 'README.md' },
      timestamp: 110,
      instanceId: 'main-instance',
      rootSessionKey: 'session-1',
    })

    handleRuntimeEvent({
      type: 'agent:tool:end',
      runId: 'run-1',
      toolCallId: 'tool-1',
      toolName: 'file_read',
      result: 'ok',
      isError: false,
      durationMs: 20,
      instanceId: 'main-instance',
      rootSessionKey: 'session-1',
    })

    const message = runtimeStore.getState().sessions.get('session-1')?.messages[0]
    expect(message?.parts).toContainEqual(expect.objectContaining({
      type: 'tool',
      id: 'tool-1',
      result: 'ok',
      status: 'done',
    }))
  })

  it('agent:abort 应提交待处理 delta 并完成流式 part', () => {
    startAssistantMessage()
    handleRuntimeEvent({
      type: 'agent:message:delta',
      runId: 'run-1',
      sessionKey: 'session-1',
      messageId: 'message-1',
      delta: '部分回复',
      totalLength: 4,
    })

    handleRuntimeEvent({
      type: 'agent:abort',
      runId: 'run-1',
      sessionKey: 'session-1',
      reason: 'user_cancel',
    })

    const message = runtimeStore.getState().sessions.get('session-1')?.messages[0]
    expect(message?.parts).toContainEqual(expect.objectContaining({
      type: 'text',
      text: '部分回复',
      status: 'done',
    }))
    expect(message?.isStreaming).toBe(false)
  })

  it('message:end 应结束当前文本 part，并让下一次 LLM 输出新建 part', () => {
    startAssistantMessage()
    handleRuntimeEvent({
      type: 'agent:message:delta',
      runId: 'run-1',
      sessionKey: 'session-1',
      messageId: 'message-1',
      delta: '第一段',
      totalLength: 3,
    })
    handleRuntimeEvent({
      type: 'agent:message:end',
      runId: 'run-1',
      sessionKey: 'session-1',
      messageId: 'message-1',
      content: [{ type: 'text', text: '第一段' }],
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: 'tool_use',
    })
    handleRuntimeEvent({
      type: 'agent:message:start',
      runId: 'run-1',
      sessionKey: 'session-1',
      messageId: 'message-2',
      model: 'test-model',
      timestamp: 120,
    })
    handleRuntimeEvent({
      type: 'agent:message:delta',
      runId: 'run-1',
      sessionKey: 'session-1',
      messageId: 'message-2',
      delta: '第二段',
      totalLength: 3,
    })
    handleRuntimeEvent({
      type: 'agent:idle',
      runId: 'run-1',
      sessionKey: 'session-1',
    })

    const message = runtimeStore.getState().sessions.get('session-1')?.messages[0]
    const textParts = message?.parts.filter((part) => part.type === 'text')
    expect(textParts).toEqual([
      expect.objectContaining({ text: '第一段', status: 'done' }),
      expect.objectContaining({ text: '\n\n第二段', status: 'done' }),
    ])
  })
})
