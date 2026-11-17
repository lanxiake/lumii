/**
 * ocr_image 工具注册与 execute 覆盖测试。
 *
 * 三条判据：
 * 1. 注入 runLocalOcr 时才注册（没注入就不让模型看见一个注定失败的工具）；
 * 2. 成功时把**坐标**原样交给模型（这是视觉模型给不了的那部分）；
 * 3. OCR 不可用 / 抛错时，模型能看懂发生了什么，而不是收到空结果。
 */
import { describe, expect, it, vi } from 'vitest'

const { registerIntegrationTools } = await import('./bridge-tool-registrar-integration')

interface RegisteredTool {
  name: string
  execute: (...args: unknown[]) => Promise<unknown>
}

function makeRegistrar(opts: {
  runLocalOcr?: (params: { imagePath: string; maxSide?: number }) => Promise<unknown>
}) {
  const registered = new Map<string, RegisteredTool>()
  const deps = {
    toolRegistry: {
      register: (tool: RegisteredTool) => registered.set(tool.name, tool),
    },
    toolContext: {},
    config: {},
    weixinCtx: { getCurrent: () => null, markSentViaTool: vi.fn() },
    getChannelRouter: () => null,
    ipcChannel: { forwardIpcEvent: vi.fn() },
    getConversationRepo: () => null,
    getMemoryManager: () => null,
    ...(opts.runLocalOcr ? { runLocalOcr: opts.runLocalOcr } : {}),
  } as unknown as Parameters<typeof registerIntegrationTools>[0]
  registerIntegrationTools(deps)
  return registered
}

function textOf(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content
  return JSON.parse(content[0].text)
}

describe('ocr_image 工具注册', () => {
  it('未注入 runLocalOcr 时不注册（模型不该看见注定失败的工具）', () => {
    const registered = makeRegistrar({})
    expect(registered.has('ocr_image')).toBe(false)
  })

  it('注入后注册，且成功结果里带着坐标框', async () => {
    const runLocalOcr = vi.fn(async () => ({
      ok: true,
      text: '登录',
      lines: [{ text: '登录', box: [120, 340, 64, 28] as [number, number, number, number], score: 0.97 }],
      confidence: 0.97,
      backend: 'dml' as const,
    }))
    const registered = makeRegistrar({ runLocalOcr })
    const tool = registered.get('ocr_image')
    expect(tool).toBeDefined()

    const body = textOf(await tool!.execute('call-1', { imagePath: 'uploads/a.png' }))
    expect(runLocalOcr).toHaveBeenCalledWith({ imagePath: 'uploads/a.png' })
    expect(body.status).toBe('ok')
    const lines = body.lines as Array<{ box: number[] }>
    expect(lines[0]!.box).toEqual([120, 340, 64, 28])
  })

  it('平台不支持时回 unavailable（让模型换办法），而不是假装图里没字', async () => {
    const registered = makeRegistrar({
      runLocalOcr: async () => ({
        ok: false,
        text: '',
        lines: [],
        confidence: 0,
        backend: 'cpu' as const,
        error: '本地 OCR 仅支持 Windows',
      }),
    })
    const body = textOf(await registered.get('ocr_image')!.execute('call-1', { imagePath: 'a.png' }))
    expect(body.status).toBe('unavailable')
    expect(String(body.message)).toContain('Windows')
  })

  it('缺 imagePath 时明确报错', async () => {
    const registered = makeRegistrar({ runLocalOcr: async () => ({ ok: true }) })
    const body = textOf(await registered.get('ocr_image')!.execute('call-1', {}))
    expect(body.status).toBe('error')
  })
})
