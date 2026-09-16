/**
 * 本机代理探测与使用（12a §四「代理决策」的落地）
 *
 * **动因（2026-09-16 实测）**：`web_fetch` 近 7 天 35.1% 的失败里，76% 是连接层失败。
 * 而那些站点**不是不可达**——TCP 握手成功（`zh.wikisource.org` 114ms），被拦在 TLS。
 * 本机系统代理开着（`127.0.0.1:10808`），走它之后 en.wikipedia / arxiv / huggingface
 * 全部恢复正常。所以「直连失败时换一条出口再试一次」能直接解掉那 76%。
 *
 * **三条刻意的边界**：
 * 1. **只在直连失败后用**。直连能通就绝不走代理——否则等于把用户所有流量静默改道。
 * 2. **只认本机地址**。候选一律 `127.0.0.1` / `localhost` / `::1`，任何远端代理地址
 *    一律拒绝——那意味着把用户流量送到别人的机器上，不是我们能替用户做的决定。
 * 3. **探测结果要自证**。端口上有人监听不等于它是代理，读一眼配置也不等于它现在能通。
 *    唯一的验证方式是**真的拿它取回一次内容**——所以「重试」本身就是「探测」，
 *    没有单独的探活步骤。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ProxyAgent, fetch as undiciFetch } from 'undici'

const execFileAsync = promisify(execFile)

const log = {
  info: (...args: unknown[]) => console.log('[local-proxy]', ...args),
  warn: (...args: unknown[]) => console.warn('[local-proxy]', ...args),
}

/**
 * 常见本地代理端口，顺序即尝试顺序。
 * 前几个是 Clash / v2ray / Verge 的默认值，命中率最高。
 */
export const COMMON_LOCAL_PROXY_PORTS = [10808, 7890, 7897, 10809, 1080, 8080, 8888]

/** 单次经代理尝试的上限。**不复用调用方的 signal**，理由见 `retryViaLocalProxy` */
const PROXY_ATTEMPT_TIMEOUT_MS = 20_000

/** 一轮「全都试不通」之后的冷却：避免每次失败都把所有端口再扫一遍 */
const RESCAN_COOLDOWN_MS = 2 * 60_000

export interface ProxyCandidate {
  url: string
  /** 从哪探测到的。写进日志，让「为什么走了代理」可追溯 */
  source: string
}

/**
 * 只接受本机代理地址。
 * @returns 规范化后的 `http://host:port`；非本机或格式不对时为 null
 */
export function toLoopbackProxyUrl(raw: string | undefined): string | null {
  const value = raw?.trim()
  if (!value) return null
  try {
    const parsed = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`)
    const host = parsed.hostname.toLowerCase()
    if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return null
    if (!parsed.port) return null
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return null
  }
}

/**
 * 读 Windows 系统代理设置。
 *
 * 这是**最该优先信的一条**：它是用户为整个系统/浏览器配的那个代理，
 * 比我们猜端口靠谱得多。
 */
export async function readWindowsSystemProxy(): Promise<string | null> {
  if (process.platform !== 'win32') return null
  try {
    const { stdout } = await execFileAsync('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    ])
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(stdout)) return null
    const raw = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(stdout)?.[1]
    if (!raw) return null
    // ProxyServer 可能是裸 "host:port"，也可能是 "http=h:p;https=h:p"
    const httpsPart = /https=([^;]+)/i.exec(raw)?.[1]
    const httpPart = /http=([^;]+)/i.exec(raw)?.[1]
    return toLoopbackProxyUrl(httpsPart ?? httpPart ?? raw)
  } catch (err) {
    log.warn('读系统代理失败（忽略）:', err instanceof Error ? err.message : err)
    return null
  }
}

/** 按优先级收集候选：环境变量 → 系统代理 → 常见端口 */
export async function collectProxyCandidates(): Promise<ProxyCandidate[]> {
  const out: ProxyCandidate[] = []
  const push = (raw: string | undefined, source: string): void => {
    const url = toLoopbackProxyUrl(raw)
    if (url && !out.some((c) => c.url === url)) out.push({ url, source })
  }

  push(process.env.HTTPS_PROXY ?? process.env.https_proxy, '环境变量 HTTPS_PROXY')
  push(process.env.HTTP_PROXY ?? process.env.http_proxy, '环境变量 HTTP_PROXY')
  push(process.env.ALL_PROXY ?? process.env.all_proxy, '环境变量 ALL_PROXY')
  push((await readWindowsSystemProxy()) ?? undefined, 'Windows 系统代理')

  for (const port of COMMON_LOCAL_PROXY_PORTS) {
    push(`127.0.0.1:${port}`, `常见本地端口 ${port}`)
  }
  return out
}

/** 上次成功用过的代理。命中过就一直排在最前，省掉重新翻一遍的代价 */
let cachedProxy: { url: string; agent: ProxyAgent } | null = null
/** 上一轮全试不通的时刻，用于冷却 */
let lastExhaustedAt = 0

export interface ProxyFetchResult {
  status: number
  body: string
  /** 出处，供上层写进日志/错误信息 */
  via: string
}

async function attemptThrough(
  url: string,
  candidate: ProxyCandidate,
  headers: Record<string, string>,
): Promise<ProxyFetchResult | null> {
  // 复用命中过的 agent（它带连接池）；没命中过的用完即关，别泄漏
  const reused = cachedProxy?.url === candidate.url ? cachedProxy.agent : null
  const agent = reused ?? new ProxyAgent(candidate.url)
  try {
    const response = await undiciFetch(url, {
      headers,
      dispatcher: agent,
      signal: AbortSignal.timeout(PROXY_ATTEMPT_TIMEOUT_MS),
    })
    const body = await response.text()
    return { status: response.status, body, via: `${candidate.source}（${candidate.url}）` }
  } catch (err) {
    log.warn(
      `经 ${candidate.url} 失败（${candidate.source}）: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  } finally {
    if (!reused) void agent.close().catch(() => undefined)
  }
}

/**
 * 直连失败后，依次拿本机代理重试同一个 URL。
 *
 * **为什么不用调用方的 signal**：调用方的超时（`web-fetch-tool` 给 30 秒）在直连那一步
 * 通常已经耗掉一大半（连接层超时本身就 ~10.7 秒）。把那个 signal 传进来，
 * 代理尝试会一上来就被中止——恰恰在它最该起作用的时候失效。
 * 这里改用自己的一次性超时；总时长仍有界。
 *
 * @param candidates 仅测试用：直接给候选，跳过探测（否则单测会去扫真实端口）
 * @returns 成功（拿到了任何 HTTP 响应）时给出结果；所有候选都不通则为 null
 */
export async function retryViaLocalProxy(
  url: string,
  headers: Record<string, string>,
  candidates?: ProxyCandidate[],
): Promise<ProxyFetchResult | null> {
  // 全试不通的冷却期内不再重扫。但**命中过的代理不受冷却限制**——
  // 它排在候选表最前，重试它几乎不花代价，而它很可能又通了。
  if (!cachedProxy && !candidates && Date.now() - lastExhaustedAt < RESCAN_COOLDOWN_MS) return null

  const list = candidates ?? (await collectProxyCandidates())
  if (cachedProxy) {
    const idx = list.findIndex((c) => c.url === cachedProxy!.url)
    if (idx > 0) list.unshift(...list.splice(idx, 1))
    else if (idx === -1) list.unshift({ url: cachedProxy.url, source: '上次成功的代理' })
  }

  for (const candidate of list) {
    const result = await attemptThrough(url, candidate, headers)
    if (result) {
      if (cachedProxy?.url !== candidate.url) {
        void cachedProxy?.agent.close().catch(() => undefined)
        cachedProxy = { url: candidate.url, agent: new ProxyAgent(candidate.url) }
      }
      log.info(`经 ${candidate.url} 取回成功（${candidate.source}）url=${url} status=${result.status}`)
      return result
    }
    // 之前能用、现在不能用的代理：作废，下一轮重新探测
    if (cachedProxy?.url === candidate.url) cachedProxy = null
  }

  lastExhaustedAt = Date.now()
  return null
}

/** 仅测试用：清掉探测缓存 */
export function __resetProxyCacheForTest(): void {
  void cachedProxy?.agent.close().catch(() => undefined)
  cachedProxy = null
  lastExhaustedAt = 0
}
