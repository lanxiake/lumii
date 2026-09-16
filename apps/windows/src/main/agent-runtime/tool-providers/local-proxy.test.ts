/**
 * 本机代理探测与使用。
 *
 * 用**真的本地代理服务器**（一个最小转发实现）测「经代理取回」这条路径，
 * 不 mock —— 这条路径的价值全在「真的能通」，mock 掉就等于什么都没验。
 *
 * `@vitest-environment node`：本目录默认跑在 DOM 环境里，那里没有 undici 的 fetch
 * （实测直接 "operation was aborted"）。代理这条路必须跑在真 Node 下。
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import {
  collectProxyCandidates,
  readWindowsSystemProxy,
  retryViaLocalProxy,
  toLoopbackProxyUrl,
  __resetProxyCacheForTest,
} from './local-proxy'

describe('toLoopbackProxyUrl', () => {
  it('接受本机地址的几种写法', () => {
    expect(toLoopbackProxyUrl('127.0.0.1:10808')).toBe('http://127.0.0.1:10808')
    expect(toLoopbackProxyUrl('http://127.0.0.1:10808')).toBe('http://127.0.0.1:10808')
    expect(toLoopbackProxyUrl('localhost:7890')).toBe('http://localhost:7890')
    expect(toLoopbackProxyUrl('  127.0.0.1:1080  ')).toBe('http://127.0.0.1:1080')
  })

  it('**拒绝任何非本机地址**——把用户流量送到别人机器上不是我们能替他做的决定', () => {
    expect(toLoopbackProxyUrl('192.168.1.1:8080')).toBeNull()
    expect(toLoopbackProxyUrl('10.0.0.1:1080')).toBeNull()
    expect(toLoopbackProxyUrl('proxy.example.com:8080')).toBeNull()
    expect(toLoopbackProxyUrl('http://8.8.8.8:80')).toBeNull()
  })

  it('没端口、空值、乱码都不接受', () => {
    expect(toLoopbackProxyUrl('127.0.0.1')).toBeNull()
    expect(toLoopbackProxyUrl('')).toBeNull()
    expect(toLoopbackProxyUrl(undefined)).toBeNull()
    expect(toLoopbackProxyUrl('不是个地址')).toBeNull()
  })
})

describe('collectProxyCandidates', () => {
  const KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('环境变量排在候选最前', async () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:19999'
    const list = await collectProxyCandidates()
    expect(list[0]).toEqual({ url: 'http://127.0.0.1:19999', source: '环境变量 HTTPS_PROXY' })
  })

  it('环境变量里的远端地址被剔除，不静默改道', async () => {
    process.env.HTTPS_PROXY = 'http://evil.example.com:8080'
    const list = await collectProxyCandidates()
    expect(list.some((c) => c.url.includes('evil.example.com'))).toBe(false)
  })

  it('候选里出现常见本地端口（系统代理与环境变量都没有时的兜底）', async () => {
    const list = await collectProxyCandidates()
    expect(list.some((c) => c.url === 'http://127.0.0.1:10808')).toBe(true)
  })
})

describe('readWindowsSystemProxy', () => {
  it('非 Windows 平台返回 null（不抛）', async () => {
    if (process.platform === 'win32') {
      // 本机是 Windows：只要求「要么给本机地址，要么 null」，不硬编端口
      const v = await readWindowsSystemProxy()
      expect(v === null || v.startsWith('http://127.0.0.1')).toBe(true)
    } else {
      expect(await readWindowsSystemProxy()).toBeNull()
    }
  })
})

describe('retryViaLocalProxy（真代理）', () => {
  let target: http.Server
  let proxy: http.Server
  let targetUrl: string
  let proxyUrl: string

  beforeEach(async () => {
    // 被访问的目标站
    target = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('取到了')
    })
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r))
    targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/`

    // 最小转发代理。
    // 关键细节：undici 的 ProxyAgent **对 http 目标也走 CONNECT 隧道**，
    // 不是「绝对 URI 的普通转发」。只实现 createServer 的回调会一直等到超时
    // （实测：代理侧收不到任何请求）。两种形态都实现，免得以后换实现又踩一次。
    proxy = http.createServer((req, res) => {
      const absolute = new URL(req.url ?? '/', 'http://placeholder')
      const upstream = http.request(
        {
          hostname: absolute.hostname,
          port: absolute.port || 80,
          path: `${absolute.pathname}${absolute.search}`,
          method: req.method,
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

  it('经代理真的取回了内容', async () => {
    const result = await retryViaLocalProxy(targetUrl, {}, [{ url: proxyUrl, source: '测试代理' }])
    expect(result?.status).toBe(200)
    expect(result?.body).toBe('取到了')
    expect(result?.via).toContain('测试代理')
  })

  it('候选都不通时返回 null（而不是抛错或返回一个假的成功）', async () => {
    // 一个没人监听的端口
    const dead = 'http://127.0.0.1:1'
    const result = await retryViaLocalProxy(targetUrl, {}, [{ url: dead, source: '死端口' }])
    expect(result).toBeNull()
  })

  it('第一个通不了就换下一个（探测是逐个自证的）', async () => {
    const result = await retryViaLocalProxy(targetUrl, {}, [
      { url: 'http://127.0.0.1:1', source: '死端口' },
      { url: proxyUrl, source: '测试代理' },
    ])
    expect(result?.status).toBe(200)
    expect(result?.via).toContain('测试代理')
  })

  it('命中过的代理会被优先复用（不必重新逐个试）', async () => {
    await retryViaLocalProxy(targetUrl, {}, [{ url: proxyUrl, source: '测试代理' }])
    // 第二轮只给一个不通的候选，缓存里的那个应当被插到最前并胜出
    const result = await retryViaLocalProxy(targetUrl, {}, [{ url: 'http://127.0.0.1:1', source: '死端口' }])
    expect(result?.status).toBe(200)
    // 复用时来源标签是「上次成功的代理」（它已经不来自本轮候选表了），
    // 认地址而不是认标签
    expect(result?.via).toContain(proxyUrl)
  })

  it('全部试不通后进入冷却，不重复扫端口', async () => {
    const dead = [{ url: 'http://127.0.0.1:1', source: '死端口' }]
    expect(await retryViaLocalProxy(targetUrl, {}, dead)).toBeNull()
    // 冷却期内、且没有缓存的代理 → 连候选都不去收集
    const before = Date.now()
    expect(await retryViaLocalProxy(targetUrl, {})).toBeNull()
    expect(Date.now() - before).toBeLessThan(100)
  })
})
