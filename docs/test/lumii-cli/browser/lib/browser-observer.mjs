/**
 * browser-observer — 独立于被测代码的浏览器观测通道
 *
 * ## 为什么需要它
 *
 * 「浏览器操作准不准」如果用 `browser_eval` 自己去读页面，就是**拿被测对象验证被测对象**——
 * 工具链里任何一环撒谎（回错 url、回旧快照、结果没落地）都测不出来。2026-09-21 那次
 * 事故正是如此：模型在推理文本里编了个工具结果，而当时没有任何独立通道能证伪它。
 *
 * 所以观测走**裸 CDP**：直接连 Chrome 的调试端口，用 `Runtime.evaluate` 读页面真实状态。
 * 不经过 Lumii 的 playwright 会话、不经过工具层、不经过模型。
 *
 * ## 为什么是裸 CDP 而不是 playwright.connectOverCDP
 *
 * Lumii 自己就持有这个 Chrome 的 CDP 长连接（`pw-session.ts` 缓存 `ConnectedBrowser`）。
 * playwright 再连一次虽然是合法的（CDP 支持多客户端），但它会建立完整的 Browser 包装、
 * 订阅一堆域；观测器只需要"读一个变量"，用最薄的通道风险最低。Node 24 自带 WebSocket，
 * 连依赖都不用加。
 *
 * ## 只读纪律
 *
 * 本模块**只发 `Runtime.evaluate` 且表达式一律是读操作**。驱动页面的是被测的浏览器工具，
 * 观测器一旦写页面，用例就不再能证明"工具做了这件事"。
 */

import http from 'node:http'

const DEFAULT_CDP_PORT = 18791

/** 观测器默认端口；与 browser-service.ts 的 DEFAULT_CDP_PORT 对齐 */
export function cdpPort() {
  const env = process.env.LUMII_CDP_PORT
  const n = env ? Number(env) : DEFAULT_CDP_PORT
  return Number.isFinite(n) ? n : DEFAULT_CDP_PORT
}

function httpJson(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (body += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(body))
        } catch {
          resolve(null)
        }
      })
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
    req.on('error', () => resolve(null))
  })
}

/**
 * CDP 是否可达（即 Lumii 是否已经把 Chrome 拉起来了）。
 *
 * **按需启动**是这里的关键事实：Chrome 不是随应用启动的，而是第一次调用 browser.* 工具
 * 时才开（browser-service.ts 注释：「Chrome 按需启动」）。所以套件在任何浏览器用例之前，
 * 必须先有一次真实的工具调用把浏览器拉起来——否则观测器连不上是**预期行为**，不是缺陷。
 */
export async function cdpAlive(port = cdpPort()) {
  const v = await httpJson(`http://127.0.0.1:${port}/json/version`)
  return Boolean(v && v.webSocketDebuggerUrl)
}

/** 列出可观测的页面 target（只取 type=page，过滤掉扩展/worker） */
export async function listPages(port = cdpPort()) {
  const list = await httpJson(`http://127.0.0.1:${port}/json/list`)
  if (!Array.isArray(list)) return []
  return list
    .filter((t) => t && t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
    .map((t) => ({ id: t.id, url: t.url ?? '', title: t.title ?? '', wsUrl: t.webSocketDebuggerUrl }))
}

/**
 * 在一个 target 上求值（只读）。
 * @param {string} wsUrl target 的 webSocketDebuggerUrl
 * @param {string} expression 求值表达式
 * @param {{timeoutMs?:number, awaitPromise?:boolean}} [opts]
 * @returns {Promise<{ok:boolean, value?:unknown, error?:string}>}
 */
export function evaluateOn(wsUrl, expression, { timeoutMs = 8000, awaitPromise = true } = {}) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      resolve(v)
    }
    const timer = setTimeout(() => done({ ok: false, error: `CDP evaluate 超时（${timeoutMs}ms）` }), timeoutMs)

    let ws
    try {
      ws = new WebSocket(wsUrl)
    } catch (err) {
      done({ ok: false, error: `WebSocket 建立失败: ${String(err)}` })
      return
    }

    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise, timeout: timeoutMs },
        }),
      )
    })

    ws.addEventListener('message', (ev) => {
      let msg
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      } catch {
        return
      }
      if (msg.id !== 1) return
      if (msg.error) {
        done({ ok: false, error: String(msg.error.message ?? msg.error) })
        return
      }
      const r = msg.result ?? {}
      if (r.exceptionDetails) {
        const text =
          r.exceptionDetails.exception?.description ??
          r.exceptionDetails.text ??
          'evaluate 抛出异常'
        done({ ok: false, error: String(text) })
        return
      }
      done({ ok: true, value: r.result?.value })
    })

    ws.addEventListener('error', () => done({ ok: false, error: 'WebSocket 错误（target 可能已关闭）' }))
    ws.addEventListener('close', () => done({ ok: false, error: 'WebSocket 在收到响应前关闭' }))
  })
}

/**
 * 按 URL 正则找页面并求值。
 * @returns {Promise<{ok:boolean, value?:unknown, error?:string, page?:object}>}
 */
export async function evalOnPage(port, urlPattern, expression, opts) {
  const pages = await listPages(port)
  const re = urlPattern instanceof RegExp ? urlPattern : new RegExp(String(urlPattern))
  const page = pages.find((p) => re.test(p.url))
  if (!page) {
    return { ok: false, error: `没有匹配 ${re} 的页面（当前 ${pages.length} 个：${pages.map((p) => p.url).join(', ') || '无'}）` }
  }
  const r = await evaluateOn(page.wsUrl, expression, opts)
  return { ...r, page }
}

/** 读页面里的 `window.__probe`（fixture 页面的状态字典；不存在返回 null） */
export async function readProbe(port, urlPattern) {
  const r = await evalOnPage(port, urlPattern, 'window.__probe ? JSON.parse(JSON.stringify(window.__probe)) : null')
  return r.ok ? r.value : null
}

/** 轮询直到 CDP 可达或超时（用于"等浏览器被拉起来"） */
export async function waitForCdp(port = cdpPort(), timeoutMs = 45000, intervalMs = 700) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await cdpAlive(port)) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return false
}

/** 轮询直到出现匹配 URL 的页面或超时 */
export async function waitForPage(port, urlPattern, timeoutMs = 20000, intervalMs = 500) {
  const re = urlPattern instanceof RegExp ? urlPattern : new RegExp(String(urlPattern))
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const pages = await listPages(port)
    const hit = pages.find((p) => re.test(p.url))
    if (hit) return hit
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return null
}
