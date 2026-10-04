/**
 * session_rename 工具：改当前会话的侧栏标题。
 *
 * 以前标题只能由「用户第一句」推导，宽泛开场就分不清会话；这个工具让 Agent 在
 * 用户说「改个名」或话题明显偏移时自己命名。守三件事：写对会话、广播给渲染层、坏输入不落库。
 */
import { describe, expect, it, vi } from 'vitest'
import { registerClientCommandTools } from './bridge-tool-registrar-client-cmd'
import type { BridgeToolRegistrarDeps } from './bridge-tool-registrar-types'

interface RegisteredTool {
  name: string
  execute: (id: string, params: unknown) => Promise<unknown>
}

function makeHarness(opts: { hasCurrentSession?: boolean } = {}) {
  const tools = new Map<string, RegisteredTool>()
  const forwardIpcEvent = vi.fn()
  const updateTitle = vi.fn()
  const conversationRepo = { updateTitle }
  const deps = {
    toolRegistry: { register: (t: RegisteredTool) => tools.set(t.name, t) },
    toolContext: {},
    ipcChannel: { forwardIpcEvent },
    getConversationRepo: () => conversationRepo,
    getMemoryManager: () => null,
    toolCallInstanceMap: new Map([['call-1', 'inst-1']]),
    getCurrentToolExecutorInstanceId: () => 'inst-1',
    getDefinitionIdByInstanceId: () => 'assistant',
    getMemoryReadScopeByInstanceId: () => 'agent',
    instanceToConversation: new Map<string, string>(
      opts.hasCurrentSession === false ? [] : [['inst-1', 'conv-1']],
    ),
  } as unknown as BridgeToolRegistrarDeps

  registerClientCommandTools(deps, {} as never)
  const tool = tools.get('session_rename')
  if (!tool) throw new Error('session_rename not registered')
  return { tool, forwardIpcEvent, updateTitle }
}

async function invoke(tool: RegisteredTool, params: unknown): Promise<Record<string, unknown>> {
  const result = (await tool.execute('call-1', params)) as { content: Array<{ text: string }> }
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>
}

describe('session_rename', () => {
  it('写入当前会话标题并广播 conversation:updated', async () => {
    const { tool, forwardIpcEvent, updateTitle } = makeHarness()

    const out = await invoke(tool, { title: '  雪山行程规划  ' })

    expect(updateTitle).toHaveBeenCalledWith('conv-1', '雪山行程规划')
    expect(forwardIpcEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'conversation:updated', sessionKey: 'conv-1', title: '雪山行程规划' }),
    )
    expect(out.ok).toBe(true)
    expect(out.title).toBe('雪山行程规划')
  })

  it('空标题不落库', async () => {
    const { tool, updateTitle, forwardIpcEvent } = makeHarness()

    const out = await invoke(tool, { title: '   ' })

    expect(out.ok).toBe(false)
    expect(updateTitle).not.toHaveBeenCalled()
    expect(forwardIpcEvent).not.toHaveBeenCalled()
  })

  it('无法确定当前会话时拒绝而不是乱改', async () => {
    const { tool, updateTitle } = makeHarness({ hasCurrentSession: false })

    const out = await invoke(tool, { title: '新名字' })

    expect(out.ok).toBe(false)
    expect(updateTitle).not.toHaveBeenCalled()
  })
})
