/**
 * 浏览器控制工具注册辅助函数
 *
 * 从 BridgeToolRegistrar.registerBrowserTools() 提取。
 * 通过 getBrowserContext 获取 BrowserRouteContext，注册 browser_navigate 等系列工具。
 */

import { Type } from '@sinclair/typebox'
import { ToolRegistry, createMtBotTool, type ToolExecutionContext, type MtBotTool } from '@mtbot/agent-runtime'
import { agentRuntimeLog as log, jsonToolResult } from './bridge-utils'

type GetBrowserContext = () => import('../browser-service.js').BrowserRouteContext | null

export function registerBrowserTools(
  toolRegistry: ToolRegistry,
  ctx: ToolExecutionContext,
  getBrowserContext: GetBrowserContext,
): void {
  const dispatchBrowserProxy = async (path: string, body?: unknown): Promise<unknown> => {
    const browserCtx = getBrowserContext()
    if (!browserCtx) {
      throw new Error('浏览器控制服务未启动，请确认浏览器已打开')
    }
    const { createBrowserRouteDispatcher } = await import('@mtbot/browser-control')
    const dispatcher = createBrowserRouteDispatcher(browserCtx)
    const normalizedPath = path.startsWith('/browser/') ? path.replace('/browser/', '/') : path
    const response = await dispatcher.dispatch({ method: 'POST', path: normalizedPath, query: {}, body })
    if (response.status >= 400) {
      const errMsg =
        response.body && typeof response.body === 'object' && 'error' in response.body
          ? String((response.body as { error?: unknown }).error)
          : `HTTP ${response.status}`
      throw new Error(errMsg)
    }
    return response.body
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapExecute = (path: string, buildBody?: (p: Record<string, unknown>) => unknown): any =>
    async (_id: string, rawParams: unknown) => {
      try {
        const p = rawParams as Record<string, unknown>
        const result = await dispatchBrowserProxy(path, buildBody ? buildBody(p) : undefined)
        return jsonToolResult({ ok: true, result })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return jsonToolResult({ ok: false, error: msg })
      }
    }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reg = (tool: any) => toolRegistry.register(tool as MtBotTool)

  reg(createMtBotTool({
    name: 'browser_navigate', label: 'Navigate Browser', category: 'channel' as const,
    description: 'Navigate the browser to a URL',
    parameters: Type.Object({ url: Type.String({ description: 'URL to navigate to' }) }),
    isReadOnly: false, needsPermission: false,
    execute: wrapExecute('/navigate', (p) => ({ url: p.url })),
  }, ctx))

  reg(createMtBotTool({
    name: 'browser_screenshot', label: 'Browser Screenshot', category: 'channel' as const,
    description: 'Take a screenshot of the current browser page and return the image path',
    parameters: Type.Object({}),
    isReadOnly: true, needsPermission: false,
    execute: wrapExecute('/screenshot'),
  }, ctx))

  reg(createMtBotTool({
    name: 'browser_click', label: 'Browser Click', category: 'channel' as const,
    description:
      'Click an element on the current page by ref. NOTE: browser_screenshot does not return refs; ' +
      'no tool currently exposes them. Prefer browser_eval to locate and act on elements.',
    parameters: Type.Object({
      ref: Type.Optional(Type.String({ description: 'Element ref (aria/role ref)' })),
      index: Type.Optional(Type.Number({ description: 'Legacy index, will be converted to ref' })),
    }),
    isReadOnly: false, needsPermission: false,
    execute: wrapExecute('/act', (p) => ({
      kind: 'click',
      ref: typeof p.ref === 'string' && p.ref.trim() ? p.ref.trim() : String(p.index ?? ''),
    })),
  }, ctx))

  reg(createMtBotTool({
    name: 'browser_type', label: 'Browser Type', category: 'channel' as const,
    description:
      'Type text into an input element on the current page by ref. Same ref caveat as browser_click.',
    parameters: Type.Object({
      ref: Type.Optional(Type.String({ description: 'Element ref (aria/role ref)' })),
      index: Type.Optional(Type.Number({ description: 'Legacy index, will be converted to ref' })),
      text: Type.String({ description: 'Text to type' }),
    }),
    isReadOnly: false, needsPermission: false,
    execute: wrapExecute('/act', (p) => ({
      kind: 'type',
      ref: typeof p.ref === 'string' && p.ref.trim() ? p.ref.trim() : String(p.index ?? ''),
      text: p.text,
    })),
  }, ctx))

  reg(createMtBotTool({
    name: 'browser_scroll', label: 'Browser Scroll', category: 'channel' as const,
    description: 'Scroll the current page (up, down, left, right, or to a specific element)',
    parameters: Type.Object({
      direction: Type.Optional(Type.String({ description: 'Scroll direction: up/down/left/right' })),
      amount: Type.Optional(Type.Number({ description: 'Scroll amount in pixels' })),
    }),
    isReadOnly: false, needsPermission: false,
    execute: wrapExecute('/act', (p) => {
      const direction = typeof p.direction === 'string' ? p.direction : 'down'
      const amount = typeof p.amount === 'number' ? p.amount : 500
      const signedAmount = direction === 'up' || direction === 'left' ? -Math.abs(amount) : Math.abs(amount)
      const axis = direction === 'left' || direction === 'right' ? 'x' : 'y'
      return {
        kind: 'evaluate',
        fn: axis === 'x'
          ? `(async () => { window.scrollBy(${signedAmount}, 0); return { ok: true, x: window.scrollX, y: window.scrollY }; })()`
          : `(async () => { window.scrollBy(0, ${signedAmount}); return { ok: true, x: window.scrollX, y: window.scrollY }; })()`,
      }
    }),
  }, ctx))

  reg(createMtBotTool({
    name: 'browser_wait', label: 'Browser Wait', category: 'channel' as const,
    description: 'Wait for a specified duration in milliseconds or for an element to appear',
    parameters: Type.Object({
      ms: Type.Optional(Type.Number({ description: 'Duration to wait in milliseconds' })),
      selector: Type.Optional(Type.String({ description: 'CSS selector to wait for' })),
    }),
    isReadOnly: true, needsPermission: false,
    execute: wrapExecute('/act', (p) => ({ kind: 'wait', timeMs: p.ms, selector: p.selector })),
  }, ctx))

  reg(createMtBotTool({
    name: 'browser_eval', label: 'Browser Eval', category: 'channel' as const,
    description: 'Evaluate JavaScript in the current browser page context',
    parameters: Type.Object({ script: Type.String({ description: 'JavaScript code to evaluate' }) }),
    isReadOnly: false, needsPermission: true,
    execute: wrapExecute('/browser/eval', (p) => ({ script: p.script })),
  }, ctx))

  reg(createMtBotTool({
    name: 'browser_back', label: 'Browser Back', category: 'channel' as const,
    description: 'Navigate back in browser history',
    parameters: Type.Object({}),
    isReadOnly: false, needsPermission: false,
    execute: wrapExecute('/act', () => ({
      kind: 'evaluate',
      fn: `(async () => { history.back(); return { ok: true }; })()`,
    })),
  }, ctx))

  reg(createMtBotTool({
    name: 'browser_forward', label: 'Browser Forward', category: 'channel' as const,
    description: 'Navigate forward in browser history',
    parameters: Type.Object({}),
    isReadOnly: false, needsPermission: false,
    execute: wrapExecute('/act', () => ({
      kind: 'evaluate',
      fn: `(async () => { history.forward(); return { ok: true }; })()`,
    })),
  }, ctx))

  log.info('[registerBrowserTools] browser tools registered')
}
