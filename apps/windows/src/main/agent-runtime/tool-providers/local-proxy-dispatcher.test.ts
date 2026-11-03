/**
 * 直连失败时的本机代理降级（`resolveLocalProxyDispatcher`）。
 *
 * 用**真的本地转发代理**测，不 mock —— 这条路径的价值全在"真的能通"，mock 掉等于没验。
 * 做法照抄 `local-proxy.test.ts` 的既有模式（那里已经吃过一次"只实现普通转发、
 * 但 undici 的 ProxyAgent 对 http 目标也走 CONNECT 隧道"的亏）。
 *
 * 要钉的两件事：
 * 1. **4xx 也算出口可用**——401 是目标站给的（缺 key），恰恰证明链路通了。
 *    2026-11-03 现场就是 `www.rightapi.ai` 直连超时、走 10808 拿到 401。
 * 2. 死端口不会被选中，且候选会继续往下试。
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import { resolveLocalProxyDispatcher, __resetProxyCacheForTest } from './local-proxy'

let target: http.Server
let proxy: http.Server
let proxyUrl: string
let targetUrl: string
/** 记录经过代理的请求方法与 body，用来证明 POST body 没被丢掉 */
const seen: { method?: string; body: string }[] = []

beforeEach(async () => {
  seen.length = 0
  // 目标站：任何路径都回 401（模拟"链路通但缺 key"）
  target = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push({ method: req.method, body })
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end('{"error":"missing key"}')
    })
  })
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r))
  targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/draw/v1/images/generations`

  proxy = http.createServer((req, res) => {
    const absolute = new URL(req.url ?? '/', 'http://placeholder')
    const upstream = http.request(
      {
        hostname: absolute.hostname,
        port: absolute.port || 80,
        path: `${absolute.pathname}${absolute.search}`,
        method: req.method,
        headers: req.headers,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      },
    )
    upstream.on('error', () => {
      res.writeHead(502)
      res.end('proxy upstream error')
    })
    req.pipe(upstream)
  })
  // CONNECT 隧道：ProxyAgent 对 http 目标也会走这条
  proxy.on('connect', (req, clientSocket, head) => {
    const [host, port] = (req.url ?? '').split(':')
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
  })
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r))
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`

  __resetProxyCacheForTest()
})

afterEach(async () => {
  __resetProxyCacheForTest()
  await new Promise<void>((r) => proxy.close(() => r()))
  await new Promise<void>((r) => target.close(() => r()))
})

describe('resolveLocalProxyDispatcher', () => {
  it('**4xx 也算出口可用**（401 是目标站给的，证明链路通了）', async () => {
    const picked = await resolveLocalProxyDispatcher(targetUrl, [{ url: proxyUrl, source: '测试代理' }])
    expect(picked).not.toBeNull()
    expect(picked!.via).toContain('测试代理')
  })

  it('死端口不会被选中，候选继续往下试', async () => {
    const picked = await resolveLocalProxyDispatcher(targetUrl, [
      { url: 'http://127.0.0.1:1', source: '死端口' },
      { url: proxyUrl, source: '测试代理' },
    ])
    expect(picked?.via).toContain('测试代理')
  })

  it('全都通不了时返回 null（不抛、也不给一个假的成功）', async () => {
    const picked = await resolveLocalProxyDispatcher(targetUrl, [
      { url: 'http://127.0.0.1:1', source: '死端口' },
    ])
    expect(picked).toBeNull()
  })

  it('候选为空时返回 null', async () => {
    expect(await resolveLocalProxyDispatcher(targetUrl, [])).toBeNull()
  })

  /**
   * POST body 必须原样带过去。
   *
   * 这条单独拎出来：生图是 POST + JSON body，降级逻辑若写成"重新发一个 GET 探活
   * 就当成功"，请求体就丢了——那会拿到一个 400，而错误信息看起来像"参数不对"，
   * 排查方向完全错位。这里用 dispatcher 真的发一次 POST 验证 body 到位。
   */
  it('走 dispatcher 的 POST 请求，body 原样送达', async () => {
    const picked = await resolveLocalProxyDispatcher(targetUrl, [{ url: proxyUrl, source: '测试代理' }])
    expect(picked).not.toBeNull()
    const { fetch: undiciFetch } = await import('undici')
    const resp = await undiciFetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nano-banana', prompt: '红色圆形' }),
      dispatcher: picked!.dispatcher,
    })
    expect(resp.status).toBe(401)
    const last = seen.at(-1)
    expect(last?.method).toBe('POST')
    expect(JSON.parse(last!.body)).toEqual({ model: 'nano-banana', prompt: '红色圆形' })
  })

  it('命中之后复用同一个 dispatcher（不重复扫端口）', async () => {
    const first = await resolveLocalProxyDispatcher(targetUrl, [{ url: proxyUrl, source: '测试代理' }])
    const second = await resolveLocalProxyDispatcher(targetUrl, [])
    expect(second?.dispatcher).toBe(first?.dispatcher)
  })
})
