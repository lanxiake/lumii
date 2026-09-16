/**
 * 本地 Web 请求 — ToolExecutionContext.fetch 实现
 *
 * 增强：重试、User-Agent、超时、错误分类、**直连失败后经本机代理再试**
 */

import { retryViaLocalProxy } from './local-proxy'

const log = {
  info: (...args: unknown[]) => console.log('[local-web]', ...args),
  warn: (...args: unknown[]) => console.warn('[local-web]', ...args),
}

/**
 * 换一条网络出口**有可能改变**的失败——只有这些才值得拿本机代理再试一次。
 *
 * 刻意排除：
 * - `404` / `410`：页面不存在就是不存在，换个 IP 也不会凭空出现
 * - `401`：缺凭据，和走哪条线路无关
 * - `5xx`：那是**服务器回的**，说明我们已经连上它了，换出口改不了它的错误
 */
export function isProxyWorthTrying(status: number): boolean {
  if (status === 0) return true // 连接层就没成功——本次要解决的主要对象
  if (status === 403 || status === 451) return true // 常见的按 IP / 地区拦截
  if (status === 429) return true // 按 IP 限流
  return false
}

export async function fetchLocal(
  url: string,
  opts?: RequestInit,
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ...(opts?.headers as Record<string, string> | undefined),
  }

  const direct = await fetchDirect(url, headers, opts)
  if (!isProxyWorthTrying(direct.status)) return direct

  // 直连不行，换一条出口再试一次。这是 **12a §四 的「代理决策」落地版**：
  // 实测 web_fetch 失败里 76% 是连接层失败，而那些站点不是不可达——
  // TCP 通、TLS 被拦；走本机系统代理之后大部分恢复正常。
  const viaProxy = await retryViaLocalProxy(url, headers)
  if (!viaProxy) return direct

  log.info(
    `[fetchLocal] 直连 status=${direct.status} → 经代理 status=${viaProxy.status} url=${url} via=${viaProxy.via}`,
  )
  return { status: viaProxy.status, body: viaProxy.body }
}

/**
 * 直连路径（原有逻辑，未改动行为）。
 *
 * 重试策略：只有「已经拿到响应、读正文时才断掉」值得重试——那是真的可能抖动。
 * 连接层建不起来（DNS/TCP/TLS）则不值得：2026-09-16 实测对同一个被拦的站点
 * （zh.wikisource.org，TCP 能连上、TLS 握手被拦）连续 4 次尝试、含间隔 45 秒的
 * 第 4 次，结果完全一致地是 UND_ERR_CONNECT_TIMEOUT(≈10.7s)。
 * 重试一次 = 再花 10.7 秒 + 2 秒退避，换来同一个错误。
 * 真正有效的「重试」是**换一条出口**（见上）或模型下一轮换个来源。
 */
async function fetchDirect(
  url: string,
  headers: Record<string, string>,
  opts?: RequestInit,
): Promise<{ status: number; body: string }> {
  const maxRetries = 1
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let gotResponse = false
    try {
      if (attempt > 0) {
        log.info(`[fetchLocal] 第 ${attempt + 1} 次重试 url=${url}`)
      }
      const response = await fetch(url, {
        ...opts,
        headers,
        signal: opts?.signal ?? AbortSignal.timeout(45_000),
      })
      gotResponse = true
      const body = await response.text()
      return { status: response.status, body }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      // 记分类后的原因而不是 err.message：后者永远是 "fetch failed"，
      // 日志里 133 行这样的记录等于没记
      log.warn(`[fetchLocal] 请求失败 (attempt=${attempt}) url=${url}: ${classifyFetchError(lastError)}`)
      if (!gotResponse || attempt >= maxRetries) break
      await new Promise((r) => setTimeout(r, 2000))
    }
  }

  // 所有重试都失败，返回错误信息而非抛出。
  // status=0 是「连接层就没成功」的约定；body 只放分类后的原因，不放 URL——
  // 调用方本来就知道 URL，重复一遍只会让最终错误信息更长。
  return { status: 0, body: classifyFetchError(lastError) }
}

/**
 * undici 的 message 永远是一句笼统的 "fetch failed"，
 * 真正可用的是挂在 cause 上的 code/name（UND_ERR_CONNECT_TIMEOUT、ECONNRESET…）
 * 或 AggregateError 的 errors[]。
 *
 * 不读它，错误信息就退化成「网络请求失败: fetch failed」——归因无从下手，
 * 给模型看的提示也只能是废话。实测本机 133 次抓取失败全部落在这一种。
 */
function collectCauseCodes(root: unknown): string[] {
  const codes: string[] = []
  const seen = new Set<unknown>()
  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > 3 || seen.has(node)) return
    seen.add(node)
    const n = node as { code?: unknown; name?: unknown; errors?: unknown; cause?: unknown }
    if (typeof n.code === 'string' && n.code) codes.push(n.code)
    else if (typeof n.name === 'string' && n.name !== 'Error') codes.push(n.name)
    if (Array.isArray(n.errors)) for (const child of n.errors) walk(child, depth + 1)
    walk(n.cause, depth + 1)
  }
  walk(root, 0)
  return codes
}

/** 连接层错误码 → 人话。表里没有的码原样带出来，至少比「fetch failed」有信息量 */
const CAUSE_HINTS: Record<string, string> = {
  UND_ERR_CONNECT_TIMEOUT: '连接超时（10 秒内没建立起连接）',
  UND_ERR_HEADERS_TIMEOUT: '响应超时（连上了但服务端没回）',
  UND_ERR_BODY_TIMEOUT: '读取响应超时',
  UND_ERR_SOCKET: '连接被中断',
  UND_ERR_CLOSED: '连接已关闭',
  ETIMEDOUT: '连接超时',
  ECONNRESET: '连接被重置',
  ECONNREFUSED: '连接被拒绝',
  EHOSTUNREACH: '主机不可达',
  ENETUNREACH: '网络不可达',
  ENOTFOUND: '域名解析不到',
  EAI_AGAIN: 'DNS 解析暂时失败',
  CERT_HAS_EXPIRED: '证书已过期',
  DEPTH_ZERO_SELF_SIGNED_CERT: '自签名证书，校验不通过',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '证书链校验失败',
}

export function classifyFetchError(err: Error | null): string {
  const msg = err?.message ?? '未知错误'
  const name = err?.name ?? ''
  if (name === 'TimeoutError' || name === 'AbortError' || /abort|timeout/i.test(msg)) {
    return '请求超时（已中止）'
  }
  const codes = collectCauseCodes(err)
  for (const code of codes) {
    const hint = CAUSE_HINTS[code]
    if (hint) return `${hint}（${code}）`
  }
  if (codes.length > 0) return `网络请求失败（${codes.join(' / ')}）`
  return `网络请求失败（${msg}）`
}
