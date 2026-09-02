/**
 * switchSession 冷加载路径：currentSessionKey 必须在 await DB 之前就切过去。
 *
 * useAgentRuntimeState 按 currentSessionKey 选当前会话的消息，
 * 原实现只在末尾 setState 里写 currentSessionKey，于是「等三个 IPC 回来」的那段窗口
 * UI 仍显示旧会话：期间发出的消息和回流的 agent 事件都记在新会话上，
 * 而屏幕上渲染的是旧会话 → 表现为「发了消息但 Agent 回复不显示」。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { runtimeStore, resetRuntimeStore, getDefaultPerSessionState } from './agent-runtime-store'
import { switchSession } from './switch-session'

/** 让 sendCommand 的 promise 由测试掌控，以便观察 await 期间的 store 状态 */
function makeDeferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('switchSession 冷加载路径', () => {
  beforeEach(() => {
    resetRuntimeStore()
  })

  it('DB 历史尚未返回时 currentSessionKey 就已指向目标会话', async () => {
    const messagesGate = makeDeferred<unknown>()

    const sendCommand = vi.fn((cmd: { type: string }) => {
      if (cmd.type === 'conversation:messages') return messagesGate.promise
      if (cmd.type === 'files:list') return Promise.resolve({ files: [] })
      if (cmd.type === 'tasks:list') return Promise.resolve({ tasks: [] })
      if (cmd.type === 'conversation:context-usage') {
        return Promise.resolve({ usedTokens: 0, contextWindow: 200_000, triggerThreshold: 0.8 })
      }
      return Promise.resolve({})
    })

    ;(globalThis as unknown as { window: unknown }).window = {
      electronAPI: { agentRuntime: { sendCommand } },
    }

    runtimeStore.setState((prev) => ({ ...prev, currentSessionKey: 'old-session' }))

    // 目标会话内存中无消息 → 走冷加载分支
    const pending = switchSession('new-session')

    // 关键断言：DB 尚未返回，但当前会话已经切换，UI 不会再渲染旧会话
    expect(runtimeStore.getState().currentSessionKey).toBe('new-session')

    messagesGate.resolve({ items: [], hasMore: false, nextCursor: null })
    await pending

    expect(runtimeStore.getState().currentSessionKey).toBe('new-session')
  })

  it('通道占位消息（incoming-*）会走 DB 冷加载而非缓存捷径', async () => {
    const sendCommand = vi.fn((cmd: { type: string }) => {
      if (cmd.type === 'conversation:messages') {
        return Promise.resolve({
          items: [
            {
              id: 'db-user-1',
              role: 'user',
              content: [{ type: 'text', text: '截图看下电脑管家页面是否打开' }],
              timestamp: Date.now() - 1000,
            },
            {
              id: 'db-assistant-1',
              role: 'assistant',
              content: [{ type: 'text', text: '已完成截图' }],
              timestamp: Date.now(),
            },
          ],
          hasMore: false,
          nextCursor: null,
        })
      }
      if (cmd.type === 'files:list') return Promise.resolve({ files: [] })
      if (cmd.type === 'tasks:list') return Promise.resolve({ tasks: [] })
      if (cmd.type === 'conversation:context-usage') {
        return Promise.resolve({ usedTokens: 100, contextWindow: 200_000, triggerThreshold: 0.8 })
      }
      return Promise.resolve({})
    })

    ;(globalThis as unknown as { window: unknown }).window = {
      electronAPI: { agentRuntime: { sendCommand } },
    }

    const sessionKey = 'weixin:user@im.wechat'
    runtimeStore.setState((prev) => {
      const sessions = new Map(prev.sessions)
      sessions.set(sessionKey, {
        ...getDefaultPerSessionState(),
        messages: [{
          id: 'incoming-1234567890-abcd',
          role: 'user',
          content: [{ type: 'text', text: '截图看下电脑管家页面是否打开' }],
          parts: [],
          timestamp: Date.now(),
          isStreaming: false,
          toolCalls: [],
        }],
      })
      return { ...prev, sessions, currentSessionKey: 'other-session' }
    })

    await switchSession(sessionKey)

    const loaded = runtimeStore.getState().sessions.get(sessionKey)
    expect(loaded?.messages.length).toBe(2)
    expect(loaded?.messages.some((m) => m.id.startsWith('incoming-'))).toBe(false)
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({ type: 'conversation:messages' }))
  })
})
