/**
 * browser_snapshot 请求形状与载荷契约测试
 *
 * 为什么单开一个文件：要看请求形状就得 mock `@mtbot/browser-control` 的 dispatcher，
 * 而 `bridge-browser-tools.test.ts` 用的是真 dispatcher 验证「路由真的存在」。
 * `vi.mock` 是文件级的，混在一起会互相拆台，所以两边分居。
 *
 * 锁三条：
 *  1. 默认走 `mode=efficient`（compact + interactive + 带 ref），而不是全量 AI 快照
 *  2. 只有 full=true 才放开 maxChars 走全量
 *  3. 快照以纯文本返回（带 url / ref 数表头），模型能从里面挑 ref 去 click
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const dispatchMock = vi.fn()

vi.mock('@mtbot/browser-control', () => ({
  createBrowserRouteDispatcher: () => ({ dispatch: dispatchMock }),
}))

import { ToolRegistry, type ToolExecutionContext } from '@mtbot/agent-runtime'
import type { BrowserRouteContext } from '@mtbot/browser-control'
import { registerBrowserTools } from './bridge-browser-tools'
import { parseJsonToolResultPayload } from './bridge-utils'

function stubContext(): ToolExecutionContext {
  return {
    executeCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    readFile: async () => '',
    writeFile: async () => {},
    glob: async () => [],
    grep: async () => [],
    fetch: async () => ({ status: 200, body: '' }),
    getCwd: () => '/',
  }
}

function snapshotExecute() {
  const registry = new ToolRegistry()
  registerBrowserTools(registry, stubContext(), () => ({}) as BrowserRouteContext)
  const tool = registry.get('browser_snapshot')
  expect(tool).toBeDefined()
  return tool!.execute.bind(tool)
}

/** 成功响应体（role 快照形状：snapshot + refs + stats） */
const okBody = {
  ok: true,
  format: 'ai',
  targetId: 'target-1',
  url: 'https://example.com/',
  snapshot: '- button "搜索" [ref=e12]',
  refs: { e12: { role: 'button', name: '搜索' } },
  stats: { lines: 1, chars: 24, refs: 1, interactive: 1 },
}

function textOf(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0]!.text
}

describe('browser_snapshot', () => {
  beforeEach(() => {
    dispatchMock.mockReset()
  })

  it('默认 GET /snapshot?format=ai&mode=efficient（compact 带 ref 的快照）', async () => {
    dispatchMock.mockResolvedValue({ status: 200, body: okBody })
    const result = await snapshotExecute()('tc1', {})

    expect(dispatchMock).toHaveBeenCalledWith({
      method: 'GET',
      path: '/snapshot',
      query: { format: 'ai', mode: 'efficient' },
      body: undefined,
    })
    expect(textOf(result)).toContain('refs=1')
    expect(textOf(result)).toContain('[ref=e12]')
  })

  it('full=true 走全量快照并带上 maxChars（不传 mode）', async () => {
    dispatchMock.mockResolvedValue({
      status: 200,
      body: { ...okBody, snapshot: '页面正文', stats: undefined, refs: { e1: {}, e2: {} } },
    })
    await snapshotExecute()('tc1', { full: true, maxChars: 4000 })

    expect(dispatchMock).toHaveBeenCalledWith({
      method: 'GET',
      path: '/snapshot',
      query: { format: 'ai', maxChars: 4000 },
      body: undefined,
    })
  })

  it('selector 传下去（限定子树）', async () => {
    dispatchMock.mockResolvedValue({ status: 200, body: okBody })
    await snapshotExecute()('tc1', { selector: '  #main  ' })

    expect(dispatchMock).toHaveBeenCalledWith({
      method: 'GET',
      path: '/snapshot',
      query: { format: 'ai', mode: 'efficient', selector: '#main' },
      body: undefined,
    })
  })

  it('空快照给失败载荷，而不是空文本骗模型', async () => {
    dispatchMock.mockResolvedValue({ status: 200, body: { ...okBody, snapshot: '   ' } })
    const result = await snapshotExecute()('tc1', {})

    expect(parseJsonToolResultPayload(result)?.ok).toBe(false)
    expect(String(parseJsonToolResultPayload(result)?.error)).toContain('快照为空')
  })

  it('路由报错原样透出（HTTP 500 载荷里的 error 字段）', async () => {
    dispatchMock.mockResolvedValue({ status: 500, body: { error: 'Tab not found' } })
    const result = await snapshotExecute()('tc1', {})

    expect(parseJsonToolResultPayload(result)?.ok).toBe(false)
    expect(String(parseJsonToolResultPayload(result)?.error)).toBe('Tab not found')
  })
})
