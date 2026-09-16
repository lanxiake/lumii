/**
 * agent-json-task：临时会话跑一次 LLM 并取回 JSON 的编排逻辑
 *
 * 覆盖：正常解析、跨会话事件过滤、运行错误、解析失败、取消、运行时不可用。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runAgentJsonTask } from './agent-json-task'

type Handler = (payload: unknown) => void

function createFakeApi() {
  const handlers = new Map<string, Handler[]>()
  const commands: Array<Record<string, unknown>> = []

  const api = {
    sendCommand: vi.fn(async (cmd: Record<string, unknown>) => {
      commands.push(cmd)
      if (cmd.type === 'conversation:create') return { sessionKey: 'sk-1' }
      return { ok: true }
    }),
    onEventType: (type: string, handler: Handler) => {
      handlers.set(type, [...(handlers.get(type) ?? []), handler])
      return () => {
        handlers.set(type, (handlers.get(type) ?? []).filter((h) => h !== handler))
      }
    },
  }

  return {
    api,
    commands,
    emit(type: string, payload: unknown) {
      for (const handler of [...(handlers.get(type) ?? [])]) handler(payload)
    },
    listenerTotal() {
      let total = 0
      for (const list of handlers.values()) total += list.length
      return total
    },
  }
}

/** 让 create 会话的 await 链跑完，sessionKey 才会就位 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const parseArray = (text: string): string[] | null => {
  try {
    const data = JSON.parse(text) as unknown
    return Array.isArray(data) ? (data as string[]) : null
  } catch {
    return null
  }
}

describe('runAgentJsonTask', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('delta 累积后 idle 解析成功并关闭会话', async () => {
    const fake = createFakeApi()
    ;(window as any).electronAPI = { agentRuntime: fake.api }

    const task = runAgentJsonTask<string[]>({
      title: 't',
      prompt: 'p',
      parse: parseArray,
    })

    await flush()
    fake.emit('agent:message:delta', { sessionKey: 'sk-1', delta: '["a"' })
    fake.emit('agent:message:delta', { sessionKey: 'sk-1', delta: ', "b"]' })
    fake.emit('agent:idle', { sessionKey: 'sk-1' })

    await expect(task.done).resolves.toEqual(['a', 'b'])
    expect(fake.commands).toContainEqual({ type: 'conversation:close', sessionKey: 'sk-1' })
    // 结束后监听器全部注销，避免污染后续会话
    expect(fake.listenerTotal()).toBe(0)
  })

  it('流式过程中拿到可解析结果会回调 onPartial', async () => {
    const fake = createFakeApi()
    ;(window as any).electronAPI = { agentRuntime: fake.api }

    const onPartial = vi.fn()
    const task = runAgentJsonTask<string[]>({
      title: 't',
      prompt: 'p',
      parse: parseArray,
      onPartial,
    })

    await flush()
    fake.emit('agent:message:delta', { sessionKey: 'sk-1', delta: '[]' })
    fake.emit('agent:idle', { sessionKey: 'sk-1' })
    await task.done

    expect(onPartial).toHaveBeenCalledWith([])
  })

  it('忽略其他会话的事件', async () => {
    const fake = createFakeApi()
    ;(window as any).electronAPI = { agentRuntime: fake.api }

    const task = runAgentJsonTask<string[]>({ title: 't', prompt: 'p', parse: parseArray })
    await flush()

    fake.emit('agent:message:delta', { sessionKey: 'other', delta: '["x"]' })
    fake.emit('agent:idle', { sessionKey: 'other' })
    fake.emit('agent:idle', { sessionKey: 'sk-1' })

    // 自己的会话没有 delta，最终文本为空 → 解析失败
    await expect(task.done).rejects.toThrow()
  })

  it('Agent 运行错误时 reject', async () => {
    const fake = createFakeApi()
    ;(window as any).electronAPI = { agentRuntime: fake.api }

    const task = runAgentJsonTask<string[]>({ title: 't', prompt: 'p', parse: parseArray })
    await flush()
    fake.emit('agent:error', { sessionKey: 'sk-1', errorMessage: '模型挂了' })

    await expect(task.done).rejects.toThrow('模型挂了')
  })

  it('idle 时仍解析不出则 reject，并把原始文本带进错误信息', async () => {
    const fake = createFakeApi()
    ;(window as any).electronAPI = { agentRuntime: fake.api }

    const task = runAgentJsonTask<string[]>({ title: 't', prompt: 'p', parse: parseArray })
    await flush()
    fake.emit('agent:message:delta', { sessionKey: 'sk-1', delta: '抱歉，我做不到' })
    fake.emit('agent:idle', { sessionKey: 'sk-1' })

    await expect(task.done).rejects.toThrow('抱歉，我做不到')
  })

  it('cancel 后不再兑现结果，但仍关闭会话', async () => {
    const fake = createFakeApi()
    ;(window as any).electronAPI = { agentRuntime: fake.api }

    let settled = false
    const task = runAgentJsonTask<string[]>({ title: 't', prompt: 'p', parse: parseArray })
    void task.done.then(
      () => { settled = true },
      () => { settled = true },
    )

    await flush()
    task.cancel()
    fake.emit('agent:idle', { sessionKey: 'sk-1' })
    await flush()

    expect(settled).toBe(false)
    expect(fake.listenerTotal()).toBe(0)
    expect(fake.commands).toContainEqual({ type: 'conversation:close', sessionKey: 'sk-1' })
  })

  it('运行时不可用时立即 reject', async () => {
    ;(window as any).electronAPI = {}

    const task = runAgentJsonTask<string[]>({ title: 't', prompt: 'p', parse: parseArray })
    await expect(task.done).rejects.toThrow('客户端 Agent 运行时不可用')
  })
})
