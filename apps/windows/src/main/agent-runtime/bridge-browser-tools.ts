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

/** 浏览器路由请求：/snapshot 是 GET + query，其余路由都是 POST + body */
type BrowserRouteRequest = {
  method?: 'GET' | 'POST'
  query?: Record<string, unknown>
  body?: unknown
}

export function registerBrowserTools(
  toolRegistry: ToolRegistry,
  ctx: ToolExecutionContext,
  getBrowserContext: GetBrowserContext,
): void {
  const dispatchRoute = async (path: string, req: BrowserRouteRequest = {}): Promise<unknown> => {
    const browserCtx = getBrowserContext()
    if (!browserCtx) {
      throw new Error('浏览器控制服务未启动，请确认浏览器已打开')
    }
    const { createBrowserRouteDispatcher } = await import('@mtbot/browser-control')
    const dispatcher = createBrowserRouteDispatcher(browserCtx)
    const normalizedPath = path.startsWith('/browser/') ? path.replace('/browser/', '/') : path
    const response = await dispatcher.dispatch({
      method: req.method ?? 'POST',
      path: normalizedPath,
      query: req.query ?? {},
      body: req.body,
    })
    if (response.status >= 400) {
      const errMsg =
        response.body && typeof response.body === 'object' && 'error' in response.body
          ? String((response.body as { error?: unknown }).error)
          : `HTTP ${response.status}`
      throw new Error(errMsg)
    }
    return response.body
  }

  const dispatchBrowserProxy = (path: string, body?: unknown): Promise<unknown> =>
    dispatchRoute(path, { body })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapExecute = (
    path: string,
    buildBody?: (p: Record<string, unknown>) => unknown,
    pick?: (body: unknown) => unknown,
  ): any =>
    async (_id: string, rawParams: unknown) => {
      try {
        const p = rawParams as Record<string, unknown>
        const result = await dispatchBrowserProxy(path, buildBody ? buildBody(p) : undefined)
        return jsonToolResult({ ok: true, result: pick ? pick(result) : result })
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
    name: 'browser_snapshot', label: 'Browser Snapshot', category: 'channel' as const,
    description:
      'Get the current page as a text tree whose interactive elements carry refs (e.g. [ref=e12]). ' +
      'browser_click / browser_type take their `ref` from here, so call this before acting on a page. ' +
      'The default tree is compact (interactive elements only); pass full=true to read page text instead.',
    parameters: Type.Object({
      full: Type.Optional(Type.Boolean({
        description: 'Return full page content instead of the compact interactive tree — use it to read text, not to act',
      })),
      selector: Type.Optional(Type.String({ description: 'CSS selector to snapshot only a subtree' })),
      maxChars: Type.Optional(Type.Number({ description: 'Truncate the snapshot (full mode) to this many characters' })),
    }),
    isReadOnly: true, needsPermission: false,
    execute: async (_id: string, rawParams: unknown) => {
      try {
        const p = (rawParams ?? {}) as { full?: boolean; selector?: string; maxChars?: number }
        const query: Record<string, unknown> = { format: 'ai' }
        if (p.full) {
          if (typeof p.maxChars === 'number' && p.maxChars > 0) query.maxChars = p.maxChars
        } else {
          // efficient = compact + interactive + 默认深度，产出带 ref 的小快照
          query.mode = 'efficient'
        }
        const selector = typeof p.selector === 'string' ? p.selector.trim() : ''
        if (selector) query.selector = selector

        const body = (await dispatchRoute('/snapshot', { method: 'GET', query })) as {
          snapshot?: unknown
          targetId?: unknown
          url?: unknown
          refs?: Record<string, unknown>
          stats?: { refs?: unknown }
          truncated?: boolean
        }
        const snapshot = typeof body?.snapshot === 'string' ? body.snapshot.trim() : ''
        if (!snapshot) {
          return jsonToolResult({ ok: false, error: '快照为空：页面可能尚未加载完成' })
        }
        const refCount =
          typeof body?.stats?.refs === 'number' ? body.stats.refs : Object.keys(body?.refs ?? {}).length
        const header = `[page] ${String(body?.url ?? '')} refs=${refCount}${body?.truncated ? ' truncated' : ''}`
        return {
          content: [{ type: 'text', text: `${header}\n${snapshot}` }],
          details: { targetId: body?.targetId, url: body?.url, refs: refCount },
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return jsonToolResult({ ok: false, error: msg })
      }
    },
  }, ctx))

  reg(createMtBotTool({
    name: 'browser_screenshot', label: 'Browser Screenshot', category: 'channel' as const,
    description:
      'Take a screenshot of the current browser page and return the image path. ' +
      'For element refs (needed by browser_click / browser_type) use browser_snapshot instead.',
    parameters: Type.Object({}),
    isReadOnly: true, needsPermission: false,
    execute: wrapExecute('/screenshot'),
  }, ctx))

  reg(createMtBotTool({
    name: 'browser_click', label: 'Browser Click', category: 'channel' as const,
    description:
      'Click an element on the current page by ref. Refs come from browser_snapshot (e.g. [ref=e12]); ' +
      'take a fresh snapshot after the page changes.',
    parameters: Type.Object({
      ref: Type.Optional(Type.String({ description: 'Element ref from browser_snapshot, e.g. "e12"' })),
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
      'Type text into an input element on the current page by ref. Same ref source as browser_click: ' +
      'browser_snapshot.',
    parameters: Type.Object({
      ref: Type.Optional(Type.String({ description: 'Element ref from browser_snapshot, e.g. "e12"' })),
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
    description:
      'Evaluate JavaScript in the current browser page context and return its value. ' +
      'The script is evaluated as an expression or function body (wrap multi-step logic in an IIFE). ' +
      'For clicking/typing prefer browser_snapshot + browser_click / browser_type; use this to read page ' +
      'state or do something refs cannot express.',
    parameters: Type.Object({ script: Type.String({ description: 'JavaScript code to evaluate' }) }),
    isReadOnly: false, needsPermission: true,
    // 服务端评估入口是 /act 的 evaluate 分支（没有独立的 /eval 路由）
    execute: wrapExecute(
      '/act',
      (p) => ({ kind: 'evaluate', fn: p.script }),
      (body) => (body as { result?: unknown } | undefined)?.result,
    ),
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
