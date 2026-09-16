/**
 * Agent JSON 任务 — 用一次性临时会话跑一轮 LLM，取回结构化 JSON
 *
 * 收拢「conversation:create → user:send → 监听 delta/idle → conversation:close」这套流程，
 * 供 AI 生成团队、优化团队、Agent 表单的「AI 自动填写」三处共用。
 * 事件按 sessionKey 过滤，避免与聊天页等并发会话串台。
 */

import type {
  AgentIdleEvent,
  AgentMessageDeltaEvent,
  AgentMessageEndEvent,
  AgentErrorEvent,
} from '@/shared/agent-runtime-events'

export interface AgentJsonTaskOptions<T> {
  /** 临时会话标题（会话列表里便于识别） */
  title: string
  /** 发送给 Agent 的完整 prompt */
  prompt: string
  /** 解析累积文本；返回 null 表示暂时解析不出（流式过程中属正常） */
  parse: (text: string) => T | null
  /** 每次拿到可解析结果时回调（流式预览用） */
  onPartial?: (value: T) => void
  /** 超时上限（毫秒），默认 180s——生成团队这类长输出要留足余量 */
  timeoutMs?: number
}

export interface AgentJsonTask<T> {
  /** 会话结束且解析成功时 resolve；运行出错或最终仍解析不出时 reject */
  done: Promise<T>
  /** 中断任务并关闭会话（组件卸载时调用）；中断后 done 不再 settle */
  cancel: () => void
}

/** 默认超时：idle 事件若因任何原因不来，不能让调用方永远停在「生成中」 */
const DEFAULT_TIMEOUT_MS = 180_000

function isSameSession(eventSessionKey: string | undefined, expected: string | null): boolean {
  if (!expected) return false
  return eventSessionKey === expected
}

export function runAgentJsonTask<T>(options: AgentJsonTaskOptions<T>): AgentJsonTask<T> {
  const { title, prompt, parse, onPartial } = options

  let cancelled = false
  let finished = false
  let sessionKey: string | null = null
  let lastText = ''
  const unsubs: Array<() => void> = []

  let resolveDone!: (value: T) => void
  let rejectDone!: (error: Error) => void
  const done = new Promise<T>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })

  const api = window.electronAPI?.agentRuntime

  const closeSession = async (): Promise<void> => {
    const sk = sessionKey
    sessionKey = null
    if (!sk || !api) return
    try {
      await api.sendCommand({ type: 'conversation:close', sessionKey: sk })
    } catch {
      // 关闭失败不影响结果
    }
  }

  /** 收尾：停掉监听、关闭会话，并兑现 Promise */
  const finish = (result: { ok: true; value: T } | { ok: false; error: Error }): void => {
    if (finished || cancelled) return
    finished = true
    clearTimeout(timer)
    for (const u of unsubs) u()
    void closeSession()
    if (result.ok) resolveDone(result.value)
    else rejectDone(result.error)
  }

  const cancel = (): void => {
    if (finished || cancelled) return
    cancelled = true
    finished = true
    clearTimeout(timer)
    for (const u of unsubs) u()
    void closeSession()
  }

  const timer = setTimeout(() => {
    finish({ ok: false, error: new Error('生成超时，请重试') })
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  if (!api?.sendCommand || !api.onEventType) {
    finished = true
    clearTimeout(timer)
    rejectDone(new Error('客户端 Agent 运行时不可用'))
    return { done, cancel: () => undefined }
  }

  const onDelta = (raw: unknown): void => {
    if (cancelled || finished) return
    const e = raw as AgentMessageDeltaEvent
    if (!isSameSession(e.sessionKey, sessionKey)) return
    lastText += e.delta
    const value = parse(lastText)
    if (value !== null) onPartial?.(value)
  }

  const onIdle = (raw: unknown): void => {
    if (cancelled || finished) return
    const e = raw as AgentIdleEvent
    if (!isSameSession(e.sessionKey, sessionKey)) return
    const value = parse(lastText)
    if (value !== null) finish({ ok: true, value })
    else finish({ ok: false, error: new Error(lastText.trim() || 'AI 返回格式异常，请重试') })
  }

  const onAgentError = (raw: unknown): void => {
    if (cancelled || finished) return
    const e = raw as AgentErrorEvent
    if (!isSameSession(e.sessionKey, sessionKey)) return
    finish({ ok: false, error: new Error(e.errorMessage || 'Agent 运行错误') })
  }

  const onMessageEnd = (raw: unknown): void => {
    if (cancelled || finished) return
    const e = raw as AgentMessageEndEvent
    if (!isSameSession(e.sessionKey, sessionKey)) return
    if (e.stopReason === 'error' || e.llmError) {
      finish({ ok: false, error: new Error(e.llmError?.message ?? '模型调用失败') })
    }
  }

  unsubs.push(api.onEventType('agent:message:delta', onDelta))
  unsubs.push(api.onEventType('agent:idle', onIdle))
  unsubs.push(api.onEventType('agent:error', onAgentError))
  unsubs.push(api.onEventType('agent:message:end', onMessageEnd))

  void (async () => {
    try {
      const created = (await api.sendCommand({ type: 'conversation:create', title })) as {
        sessionKey?: string
      }
      // 桥未就绪时主进程不抛错而是返回 {ok:false}，此处必须挡住：
      // 否则 sessionKey 为空 → 事件全被 isSameSession 挡掉 → done 永不 settle
      if (!created?.sessionKey) throw new Error('会话创建失败，请稍后重试')
      if (cancelled) {
        await api.sendCommand({ type: 'conversation:close', sessionKey: created.sessionKey })
        return
      }
      sessionKey = created.sessionKey
      await api.sendCommand({ type: 'user:send', sessionKey, content: prompt })
      if (cancelled) await closeSession()
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err : new Error('发送失败') })
    }
  })()

  return { done, cancel }
}
