/**
 * agent-runtime-store 辅助函数单元测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  findAnyPendingPermission,
  findAnyPendingAskUser,
  getDefaultPerSessionState,
  getPendingPermissionSnapshot,
  getPendingAskUserSnapshot,
  resetRuntimeStore,
  runtimeStore,
  type PendingAskUser,
  type PendingPermission,
} from './agent-runtime-store'
import {
  handleRuntimeEvent,
  resetAgentRuntimeEventHandlerForTests,
} from './event-handler'
import type { AgentSubagentCompletedEvent } from '../../../../shared/agent-runtime-events'

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

describe('findAnyPendingAskUser', () => {
  beforeEach(() => {
    resetRuntimeStore()
  })

  it('无待回答 ask 时返回 null', () => {
    expect(findAnyPendingAskUser(runtimeStore.getState())).toBeNull()
  })

  it('应找到非当前会话中的待回答 ask', () => {
    const pending: PendingAskUser = {
      requestId: 'ask-1',
      questions: [
        {
          question: '选哪个？',
          header: 'choice',
          options: [{ label: 'A', description: '选项 A' }],
        },
      ],
      timeoutMs: 60_000,
      receivedAt: Date.now(),
    }
    runtimeStore.setState((prev) => {
      const sessions = new Map(prev.sessions)
      sessions.set('weixin:foo@im.wechat', {
        ...getDefaultPerSessionState(),
        pendingAskUser: pending,
      })
      return { ...prev, currentSessionKey: 'local:other', sessions }
    })
    const found = findAnyPendingAskUser(runtimeStore.getState())
    expect(found?.sessionKey).toBe('weixin:foo@im.wechat')
    expect(found?.pending.requestId).toBe('ask-1')
  })

  it('getPendingAskUserSnapshot 在 ask 未变时返回稳定引用', () => {
    const pending: PendingAskUser = {
      requestId: 'ask-2',
      questions: [
        {
          question: '确认？',
          header: 'confirm',
          options: [{ label: '是', description: 'yes' }],
        },
      ],
      timeoutMs: 60_000,
      receivedAt: Date.now(),
    }
    runtimeStore.setState((prev) => {
      const sessions = new Map(prev.sessions)
      sessions.set('feishu:ou_abc', { ...getDefaultPerSessionState(), pendingAskUser: pending })
      return { ...prev, sessions }
    })
    const a = getPendingAskUserSnapshot()
    const b = getPendingAskUserSnapshot()
    expect(a).toBe(b)
    expect(a.pending?.requestId).toBe('ask-2')
  })
})

describe('handleRuntimeEvent ask-user routing', () => {
  beforeEach(() => {
    resetRuntimeStore()
    resetAgentRuntimeEventHandlerForTests()
  })

  it('agent:ask-user:request 应按 rootSessionKey 路由到渠道会话', () => {
    runtimeStore.setState((prev) => ({
      ...prev,
      currentSessionKey: 'local:desktop',
    }))
    handleRuntimeEvent({
      type: 'agent:ask-user:request',
      requestId: 'ask-r1',
      rootSessionKey: 'weixin:user1',
      questions: [
        {
          question: '选哪个？',
          header: 'pick',
          options: [{ label: 'A', description: 'a' }],
        },
      ],
      timeoutMs: 60_000,
    })
    const channelState = runtimeStore.getState().sessions.get('weixin:user1')
    expect(channelState?.pendingAskUser?.requestId).toBe('ask-r1')
    expect(runtimeStore.getState().sessions.get('local:desktop')?.pendingAskUser).toBeUndefined()
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
    expect(message?.content[0]?.text).toBe('模型调用失败：余额不足')
    expect(message?.parts).toContainEqual(expect.objectContaining({
      type: 'text',
      text: '模型调用失败：余额不足',
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
    expect(message?.content[0]?.text).toBe('模型调用失败：服务暂不可用')
    expect(message?.parts).toContainEqual(expect.objectContaining({
      type: 'text',
      text: '模型调用失败：服务暂不可用',
      status: 'done',
    }))
  })

  it('API Key 无效时给出可执行指引，并派发全局错误 toast', () => {
    startAssistantMessage()
    const toasts: string[] = []
    const onAgentError = (evt: Event) => {
      toasts.push((evt as CustomEvent<{ message: string }>).detail.message)
    }
    window.addEventListener('mtbot:agent-error', onAgentError)

    try {
      handleRuntimeEvent({
        type: 'agent:message:end',
        runId: 'run-1',
        sessionKey: 'session-1',
        messageId: 'message-1',
        content: [{ type: 'text', text: '' }],
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: 'error',
        llmError: {
          code: 'unauthorized',
          message: '401 无效的令牌',
          retryable: false,
          httpStatus: 401,
        },
      })
    } finally {
      window.removeEventListener('mtbot:agent-error', onAgentError)
    }

    const message = runtimeStore.getState().sessions.get('session-1')?.messages[0]
    expect(message?.content[0]?.text).toContain('API Key')
    expect(message?.content[0]?.text).toContain('401 无效的令牌')
    expect(message?.llmError?.code).toBe('unauthorized')
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toContain('API Key')
  })

  it('0 token 的错误消息不再被当作空回复丢弃', () => {
    startAssistantMessage()

    handleRuntimeEvent({
      type: 'agent:message:end',
      runId: 'run-1',
      sessionKey: 'session-1',
      messageId: 'message-1',
      content: [{ type: 'text', text: '' }],
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: 'error',
    })

    const session = runtimeStore.getState().sessions.get('session-1')
    expect(session?.isStreaming).toBe(false)
    expect(session?.llmRouteStatus).toBe('error')
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

  it('子 Agent 插队后，同 messageId 的续轮 message:start 不得再追加重复气泡', () => {
    // 回归：ChatContainer 出现 duplicate key `m:<messageId>`，同轮渲染出两个「执行过程」。
    // 场景：父消息流式中 → 子消息插入列表末尾 → 父续轮 message:start 时
    // turnId 丢失（例如会话切换合并只保留了 DB 字段）且末条已是子消息，旧逻辑会再 push 一条同 id。
    startAssistantMessage()
    handleRuntimeEvent({
      type: 'agent:thinking:delta',
      runId: 'run-1',
      sessionKey: 'session-1',
      delta: '先想一轮',
    })

    runtimeStore.setState((prev) => {
      const sessions = new Map(prev.sessions)
      const current = sessions.get('session-1') ?? getDefaultPerSessionState()
      const parent = current.messages[0]!
      sessions.set('session-1', {
        ...current,
        messages: [
          {
            ...parent,
            turnId: undefined,
            isStreaming: true,
          },
          {
            id: 'sub-msg-1',
            role: 'assistant' as const,
            content: [{ type: 'text' as const, text: '' }],
            parts: [],
            timestamp: Date.now(),
            isStreaming: true,
            toolCalls: [],
            sourceAgent: { instanceId: 'inst-sub', label: '灵栖情报' },
          },
        ],
      })
      return { ...prev, sessions }
    })

    handleRuntimeEvent({
      type: 'agent:message:start',
      runId: 'run-2',
      sessionKey: 'session-1',
      messageId: 'message-1',
      model: 'test-model',
      timestamp: 200,
    })

    const messages = runtimeStore.getState().sessions.get('session-1')?.messages ?? []
    const sameId = messages.filter((m) => m.id === 'message-1')
    expect(sameId).toHaveLength(1)
    expect(sameId[0]?.isStreaming).toBe(true)
    expect(sameId[0]?.turnId).toBe('run-2')
  })
})

describe('handleRuntimeEvent 异步子 Agent 完成通知', () => {
  let notifyDesktop: ReturnType<typeof vi.fn>

  beforeEach(() => {
    resetRuntimeStore()
    resetAgentRuntimeEventHandlerForTests()
    notifyDesktop = vi.fn(async () => undefined)
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = { notifyDesktop }
    runtimeStore.setState((prev) => ({ ...prev, currentSessionKey: 'local:desktop' }))
  })

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
    vi.restoreAllMocks()
  })

  function completedEvent(overrides: Partial<AgentSubagentCompletedEvent> = {}): AgentSubagentCompletedEvent {
    return {
      type: 'agent:subagent:completed',
      parentInstanceId: 'inst-parent',
      childInstanceId: 'inst-child',
      name: '灵栖情报',
      status: 'succeeded',
      summaryPreview: '调研完成，产出 3 条结论',
      sessionKey: 'conv-parent',
      ...overrides,
    }
  }

  it('用户不在父会话时弹桌面通知，点击跳转父会话', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    handleRuntimeEvent(completedEvent())
    expect(notifyDesktop).toHaveBeenCalledWith(
      'Lumii · 灵栖情报 已完成',
      expect.stringContaining('调研完成'),
      'conv-parent',
    )
  })

  it('用户正在父会话且窗口聚焦时不弹（结果实时可见，不打扰）', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    runtimeStore.setState((prev) => ({ ...prev, currentSessionKey: 'conv-parent' }))
    handleRuntimeEvent(completedEvent())
    expect(notifyDesktop).not.toHaveBeenCalled()
  })

  it('窗口不在前台时即使正在父会话也弹', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    runtimeStore.setState((prev) => ({ ...prev, currentSessionKey: 'conv-parent' }))
    handleRuntimeEvent(completedEvent())
    expect(notifyDesktop).toHaveBeenCalledTimes(1)
  })

  it('失败状态通知文案为执行失败', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    handleRuntimeEvent(completedEvent({ status: 'failed', summaryPreview: '工具调用报错：权限不足' }))
    expect(notifyDesktop).toHaveBeenCalledWith(
      'Lumii · 灵栖情报 执行失败',
      expect.stringContaining('权限不足'),
      'conv-parent',
    )
  })

  it('已取消的子 Agent 完成不通知', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    handleRuntimeEvent(completedEvent({ status: 'cancelled' }))
    expect(notifyDesktop).not.toHaveBeenCalled()
  })

  it('摘要为空时用兜底文案', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    handleRuntimeEvent(completedEvent({ summaryPreview: '   ' }))
    expect(notifyDesktop).toHaveBeenCalledWith(
      'Lumii · 灵栖情报 已完成',
      '结果已汇入会话，点击查看',
      'conv-parent',
    )
  })

  it('摘要为 NO_REPLY 哨兵时同样走兜底文案（哨兵不是内容）', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    handleRuntimeEvent(completedEvent({ summaryPreview: '\n\nNO_REPLY' }))
    expect(notifyDesktop).toHaveBeenCalledWith(
      'Lumii · 灵栖情报 已完成',
      '结果已汇入会话，点击查看',
      'conv-parent',
    )
  })
})
