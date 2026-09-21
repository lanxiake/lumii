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

/**
 * 把 `@mtbot/browser-control` 抛出的英文报错翻成中文，并补上「该怎么办」。
 *
 * **为什么不改包里的原文**：该包与网关共用，包内**所有**面向用户的报错都是英文
 * （`url is required` / `Unknown device "x"` …），只翻一句会让它中英混杂；
 * 客户端才是说中文的那一层。这与 `shell-runner` 把平台不匹配翻译成人话是同一个思路。
 *
 * **认不出的一律原样透传**——猜错的翻译比英文更难排查，而且这里挡着的正是
 * 「路由到底有没有命中」这类靠原文断言的信息（见本文件既有测试用的 `browser-route-reached`）。
 *
 * 末尾保留原始英文：报错可能被用户拿去搜索，且日志里按英文 grep 的老办法不能失效。
 * 只剥掉 `Error: ` 前缀（`String(err)` 的产物，见 dispatcher.ts），那是噪音。
 *
 * 导出供测试直接断言映射表；**接线**（两处 catch 是否真的走了它）由工具级用例守住
 * ——「实现了但没接上」在这个仓库里已经出现过不止一次（`.ps1` 死分支、`executablePath` 无人喂）。
 */
export function browserErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const withRaw = (zh: string) => `${zh}\n原始报错：${raw.replace(/^Error:\s*/, '')}`

  // 一条都没装。Ubuntu 桌面默认只有 Firefox，而它不支持 CDP —— 这是最常见的首次失败。
  if (raw.includes('No supported browser found')) {
    return withRaw(
      '本机没有可用于浏览器控制的浏览器（需要 Chrome / Edge / Brave / Chromium 之一；Firefox 不支持）。\n' +
        '· 装一个：sudo snap install chromium\n' +
        '· 或用环境变量 LUMII_BROWSER_EXECUTABLE 指向已有的 Chromium 系可执行文件，重启应用后生效',
    )
  }

  // LUMII_BROWSER_EXECUTABLE 指错了。常见两种：指到目录、路径拼错。
  const missingExe = raw.match(/browser\.executablePath not found:\s*(.+)/)
  if (missingExe) {
    return withRaw(
      `浏览器可执行文件不存在：${missingExe[1].trim()}\n` +
        '请检查环境变量 LUMII_BROWSER_EXECUTABLE——它要指向可执行文件本身' +
        '（例如 …/chrome-linux64/chrome），不是它所在的目录',
    )
  }

  // 进程起来了但 CDP 没通。手工解包的 Chromium 在 Ubuntu 23.10+ 上必然撞这条（AppArmor）。
  const cdpFailed = raw.match(/Failed to start Chrome CDP on port (\d+)/)
  if (cdpFailed) {
    return withRaw(
      `浏览器启动失败：在端口 ${cdpFailed[1]} 上等不到它的调试接口。\n` +
        '若用的是手工解包的 Chromium（非 snap / apt 安装），Ubuntu 23.10+ 的 AppArmor 限制会拒绝它的沙箱，' +
        '需另设 LUMII_BROWSER_NO_SANDBOX=1 再重启应用；包管理器安装的浏览器不受此影响',
    )
  }

  const spawnFailed = raw.match(/Failed to spawn browser executable at "([^"]+)"[^:]*:\s*(.+?)(?:\.\s*Please ensure|$)/)
  if (spawnFailed) {
    return withRaw(`无法启动浏览器进程：${spawnFailed[1]}（${spawnFailed[2].trim()}）。请确认该文件存在且可执行`)
  }

  return raw
}

/**
 * 空白页判据。浏览器以 `about:blank` 启动，会话没导航过就一直是它——
 * 此时页面上不存在任何脚本变量，evaluate 报 `X is not defined` 的根因是
 * 「没打开目标页」，不是「没读到变量」。光给错误原文，模型会把后者当前者去查
 * （2026-09-21 实测：某轮对话全程 0 次 browser_navigate，模型据此误判为作用域问题）。
 */
function isBlankPageUrl(url: string): boolean {
  return /^(about:blank|chrome:\/\/(newtab|new-tab-page))\/?$/i.test(url.trim())
}

/**
 * 组装 `browser_eval` 的返回载荷。
 *
 * `/act` 的 evaluate 分支本就回了 `url` / `targetId`（`agent.act.ts:315-320`），
 * 此前被 `pick` 丢掉、只把 `result` 递给模型——于是模型拿不到「我在哪个页面」这个
 * 唯一凭据。`about:blank` 上的 `X is not defined` 与目标页上的同名报错，处置方式
 * 完全不同，必须让模型自己能分辨。导出供测试直接断言（与 `browserErrorText` 同）。
 */
export function browserEvalPayload(body: unknown): {
  result: unknown
  url?: string
  targetId?: string
  note?: string
} {
  const b = body as { result?: unknown; url?: string; targetId?: string } | undefined
  const url = typeof b?.url === 'string' ? b.url : undefined
  return {
    result: b?.result,
    ...(url ? { url } : {}),
    ...(b?.targetId ? { targetId: b.targetId } : {}),
    ...(url && isBlankPageUrl(url)
      ? {
          note: '当前标签停在空白页，页面上没有任何脚本与变量——先用 browser_navigate 打开目标 URL 再求值。',
        }
      : {}),
  }
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
        return jsonToolResult({ ok: false, error: browserErrorText(err) })
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
        return jsonToolResult({ ok: false, error: browserErrorText(err) })
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
    execute: wrapExecute('/act', (p) => ({ kind: 'evaluate', fn: p.script }), browserEvalPayload),
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
