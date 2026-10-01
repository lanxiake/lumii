/**
 * 网络延迟探测（主进程）
 *
 * 口径：一次轻量 GET，量「请求发出 → 响应头到达」的往返毫秒。
 * 是 HTTP RTT，不是 ICMP ping —— ICMP 要管理员权限 / 裸 socket，跨平台解析也脆。
 *
 * ── 为什么专门做这几件事（2026-09-30 实网调优，冷/热连接实测差 ≈10 倍）──
 * 实测同一目标：冷连接 1183ms、热连接 110ms。延迟读数准不准，几乎全看有没有复用连接。
 *
 * 1. **专用长连接池，keepAlive 60s**。undici 默认 keepAliveTimeout 只有 4s，而这里轮询
 *    间隔 5s —— 用默认配置时每次探测都在重新建连，DNS+TCP+TLS 的握手开销被算进「延迟」，
 *    读数系统性虚高。
 * 2. **每次先预热一次（结果丢弃）**。冷连接的首个请求必然含握手，不该进统计。
 * 3. **完整读掉响应体再复用连接**。只 `cancel()` 不读，undici 会直接丢弃这条连接，
 *    下次又得握手 —— 所以探测目标刻意选极小响应（见下）。
 * 4. **多采样取中位数**，另给出最小值与抖动；计时用 `performance.now()`（单调时钟），
 *    不用 `Date.now()`（会被系统时间调整影响）。
 *
 * 探测目标刻意选「响应体极小 + 有全国/全球 CDN」的静态资源。
 * 这里只做直连探测，不走本机代理：指标要表达的是「本机到目标的直连往返」，
 * 经代理的数字反映的是代理链路，会污染语义；直连不通就如实显示离线。
 */

import { Agent, fetch as undiciFetch } from 'undici'
import type { NetGroupId, PingReport, PingResult } from '../../shared/net-latency-types'

/** 国内目标：腾讯云镜像的 robots.txt，仅 26 字节 —— 读体几乎无成本，连接能稳定复用 */
export const DOMESTIC_PING_URL = 'https://mirrors.cloud.tencent.com/robots.txt'
/** 国外目标：Cloudflare 公开测速端点的零字节响应 */
export const INTERNATIONAL_PING_URL = 'https://speed.cloudflare.com/__down?bytes=0'

/** 计入统计的样本数（不含预热那一次） */
const PING_ATTEMPTS = 3
/** 单次探测超时 */
const PING_TIMEOUT_MS = 4_000
/** 连接保活：必须显著大于轮询间隔，否则每轮都被回收、退化成冷连接 */
const KEEP_ALIVE_MS = 60_000
/** 响应体最多读这么多字节；超过就放弃这条连接（防止重定向到大页面把探测拖住） */
const MAX_DRAIN_BYTES = 64 * 1024

/** 专用连接池：每个目标一条长连接，供多轮采样与多次轮询复用 */
let directAgent: Agent | null = null

function getDirectAgent(): Agent {
  if (!directAgent) {
    directAgent = new Agent({
      keepAliveTimeout: KEEP_ALIVE_MS,
      keepAliveMaxTimeout: KEEP_ALIVE_MS,
      connections: 1,
      pipelining: 1,
    })
  }
  return directAgent
}

/** 仅供测试：关掉长连接池并清空 */
export function __resetLatencyAgentForTest(): void {
  void directAgent?.close().catch(() => undefined)
  directAgent = null
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 读完响应体，让连接能回到池子里复用。
 * 小响应直接读完；超过上限就 cancel —— 那种情况下复用不了，但至少不拖时间。
 */
async function drainBody(res: Awaited<ReturnType<typeof undiciFetch>>): Promise<void> {
  const body = res.body
  if (!body) return
  const reader = body.getReader()
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_DRAIN_BYTES) {
        await reader.cancel()
        return
      }
    }
  } catch {
    /* 读体失败不影响已记录的首字节时间 */
  }
}

/** 一次探测：量到响应头到达为止，随后把响应体读掉以保住连接 */
async function latencyOnce(url: string): Promise<number> {
  const started = performance.now()
  const res = await undiciFetch(url, {
    method: 'GET',
    dispatcher: getDirectAgent(),
    signal: AbortSignal.timeout(PING_TIMEOUT_MS),
  })
  const ms = performance.now() - started
  await drainBody(res)
  return ms
}

/** 中位数：偶数个样本取中间两个的均值 */
export function median(nums: readonly number[]): number {
  if (nums.length === 0) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** 抖动：相邻样本差值的平均绝对值（样本 <2 时为 0） */
export function jitter(samples: readonly number[]): number {
  if (samples.length < 2) return 0
  let sum = 0
  for (let i = 1; i < samples.length; i++) sum += Math.abs(samples[i] - samples[i - 1])
  return sum / (samples.length - 1)
}

/** 单组探测：预热一次丢弃，再采样 attempts 次 */
async function measureGroup(group: NetGroupId, url: string, attempts: number): Promise<PingResult> {
  try {
    await latencyOnce(url) // 预热：排除 DNS/TCP/TLS 握手
    const samples: number[] = []
    for (let i = 0; i < attempts; i++) samples.push(await latencyOnce(url))

    return {
      group,
      ok: true,
      ms: Math.round(median(samples)),
      minMs: Math.round(Math.min(...samples)),
      jitterMs: Math.round(jitter(samples)),
      samples: samples.length,
    }
  } catch (err) {
    return { group, ok: false, error: errMessage(err) }
  }
}

/**
 * 自适应：可达的两组里取中位数更低的那个；都不可达返回 null。
 * 相等时取国内（并列时稳定偏向本地区，避免读数来回跳）。
 */
export function pickBestGroup(domestic: PingResult, international: PingResult): NetGroupId | null {
  const d = domestic.ok ? domestic.ms ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY
  const i = international.ok ? international.ms ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY
  if (!Number.isFinite(d) && !Number.isFinite(i)) return null
  return d <= i ? 'domestic' : 'international'
}

/** 探测国内 / 国外两组延迟（并行），并给出自适应结果 */
export async function probeLatency(): Promise<PingReport> {
  const [domestic, international] = await Promise.all([
    measureGroup('domestic', DOMESTIC_PING_URL, PING_ATTEMPTS),
    measureGroup('international', INTERNATIONAL_PING_URL, PING_ATTEMPTS),
  ])
  return { domestic, international, best: pickBestGroup(domestic, international) }
}
