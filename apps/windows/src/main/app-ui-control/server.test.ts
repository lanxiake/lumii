import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetWindowsClientDataRootCacheForTest } from '../client-data-root'
import type { AppUiController } from './controller'
import {
  APP_UI_CONTROL_PORT_START,
  findAvailablePort,
  parseScreenshotBody,
  startAppUiControlServer,
  stopAppUiControlServer,
} from './server'

vi.mock('../vendor/ports-inspect.js', () => ({
  inspectPortUsage: vi.fn(),
}))

import { inspectPortUsage } from '../vendor/ports-inspect.js'
import type { PortUsage } from '../vendor/ports-inspect.js'

const mockedInspectPortUsage = vi.mocked(inspectPortUsage)

/** 构造 inspectPortUsage 的返回值，补齐 PortUsage 必填字段 */
function portUsage(port: number, status: 'free' | 'busy'): PortUsage {
  return { port, status, listeners: [], hints: [] }
}

function mockController(): AppUiController {
  return {
    screenshot: vi.fn(async () => ({
      ok: true as const,
      snapshotId: 'snap-1',
      width: 100,
      height: 100,
      viewState: { view: 'chat', hub: { open: false, tab: null, category: null } },
      refs: [],
      truncated: false,
      previewPath: '/tmp/snap-1.jpg',
      windowVisible: true,
    })),
    getSnapshotCache: vi.fn(),
    goto: vi.fn(async () => ({
      ok: true as const,
      view: 'chat',
      hub: { open: false, tab: null, category: null },
    })),
    click: vi.fn(async () => ({ ok: true as const })),
    type: vi.fn(async () => ({ ok: true as const })),
    select: vi.fn(async () => ({
      ok: true as const,
      value: 'openai',
      label: 'OpenAI 兼容',
      options: [{ value: 'openai', label: 'OpenAI 兼容' }],
    })),
    key: vi.fn(async () => ({ ok: true as const })),
    scroll: vi.fn(async () => ({
      ok: true as const,
      moved: true,
      container: 'div.settings-body',
      scrollTop: 300,
      scrollHeight: 900,
      clientHeight: 400,
      atTop: false,
      atBottom: false,
    })),
  }
}

/** 向本机控制口发 POST */
async function postRoute(
  port: number,
  route: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {})
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: route,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8')
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) })
        })
      },
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

describe('findAvailablePort', () => {
  beforeEach(() => {
    mockedInspectPortUsage.mockReset()
  })

  it('返回第一个空闲端口', async () => {
    mockedInspectPortUsage.mockResolvedValueOnce(portUsage(APP_UI_CONTROL_PORT_START, 'free'))
    await expect(findAvailablePort(APP_UI_CONTROL_PORT_START, 'test')).resolves.toBe(
      APP_UI_CONTROL_PORT_START,
    )
  })

  it('被占用时按 +10 步长重试，均占用则落到 startPort+30', async () => {
    mockedInspectPortUsage
      .mockResolvedValueOnce(portUsage(APP_UI_CONTROL_PORT_START, 'busy'))
      .mockResolvedValueOnce(portUsage(APP_UI_CONTROL_PORT_START + 10, 'busy'))
      .mockResolvedValueOnce(portUsage(APP_UI_CONTROL_PORT_START + 20, 'busy'))

    await expect(findAvailablePort(APP_UI_CONTROL_PORT_START, 'test')).resolves.toBe(
      APP_UI_CONTROL_PORT_START + 30,
    )
    expect(mockedInspectPortUsage).toHaveBeenCalledTimes(3)
  })
})

describe('parseScreenshotBody', () => {
  it('读取 annotate 与合法 target', () => {
    expect(parseScreenshotBody({ annotate: true, target: 'pet' })).toEqual({
      annotate: true,
      target: 'pet',
    })
  })

  it('忽略非法 target 与非真值 annotate', () => {
    expect(parseScreenshotBody({ annotate: 'no', target: 'desktop' })).toEqual({})
  })

  it('空 body 返回空选项', () => {
    expect(parseScreenshotBody(undefined)).toEqual({})
    expect(parseScreenshotBody({})).toEqual({})
  })
})

describe('startAppUiControlServer', () => {
  let tmpRoot: string
  let controller: AppUiController
  let port: number

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-app-ui-server-'))
    _resetWindowsClientDataRootCacheForTest()
    process.env.LUMII_CLIENT_DATA_DIR = tmpRoot
    controller = mockController()
    port = 0
    mockedInspectPortUsage.mockReset()
  })

  afterEach(async () => {
    await stopAppUiControlServer()
    delete process.env.LUMII_CLIENT_DATA_DIR
    _resetWindowsClientDataRootCacheForTest()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  /** 绑定随机可用端口 */
  async function startWithEphemeralPort(): Promise<{ token: string; port: number }> {
    const server = http.createServer()
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('no port')
    port = addr.port
    server.close()

    const config = await startAppUiControlServer({
      getWindow: () => null,
      controller,
      port,
      token: 'test-token-123',
    })
    return { token: config.token, port: config.port }
  }

  it('缺少或错误 token 返回 401', async () => {
    const { token } = await startWithEphemeralPort()

    const noAuth = await postRoute(port, '/screenshot', {}, undefined)
    expect(noAuth.status).toBe(401)
    expect(noAuth.json).toEqual({ ok: false, error: 'unauthorized' })

    const badAuth = await postRoute(port, '/screenshot', {}, 'wrong-token')
    expect(badAuth.status).toBe(401)

    const okAuth = await postRoute(port, '/screenshot', {}, token)
    expect(okAuth.status).toBe(200)
  })

  it('POST /screenshot /goto /click 调用 controller 对应方法', async () => {
    const { token } = await startWithEphemeralPort()

    await postRoute(port, '/screenshot', {}, token)
    expect(controller.screenshot).toHaveBeenCalledOnce()

    await postRoute(port, '/goto', { view: 'chat' }, token)
    expect(controller.goto).toHaveBeenCalledWith({ view: 'chat' })

    await postRoute(port, '/click', { ref: '3', snapshotId: 'snap-1' }, token)
    expect(controller.click).toHaveBeenCalledWith({
      action: 'click',
      ref: '3',
      snapshotId: 'snap-1',
    })
  })

  it('POST /screenshot 透传 annotate/target 到 controller', async () => {
    const { token } = await startWithEphemeralPort()

    await postRoute(port, '/screenshot', { annotate: true, target: 'pet' }, token)
    expect(controller.screenshot).toHaveBeenCalledWith({ annotate: true, target: 'pet' })
  })

  it('POST /act 按 action 分派到 type/select/key/scroll', async () => {
    const { token } = await startWithEphemeralPort()

    await postRoute(port, '/act', { action: 'type', ref: 'e3', text: '你好' }, token)
    expect(controller.type).toHaveBeenCalledWith({ action: 'type', ref: 'e3', text: '你好' })

    const selected = await postRoute(
      port,
      '/act',
      { action: 'select', ref: 'e4', value: 'openai' },
      token,
    )
    expect(controller.select).toHaveBeenCalledWith({
      action: 'select',
      ref: 'e4',
      value: 'openai',
    })
    expect(selected.json).toMatchObject({ ok: true, value: 'openai' })

    await postRoute(port, '/act', { action: 'key', key: 'Enter' }, token)
    expect(controller.key).toHaveBeenCalledWith({ action: 'key', key: 'Enter' })

    const scrolled = await postRoute(port, '/act', { action: 'scroll', ref: 'e5', dy: 300 }, token)
    expect(controller.scroll).toHaveBeenCalledWith({ action: 'scroll', ref: 'e5', dy: 300 })
    expect(scrolled.json).toMatchObject({ ok: true, moved: true, atBottom: false })
  })

  it('POST /act 缺少或非法 action 返回 usage', async () => {
    const { token } = await startWithEphemeralPort()

    const res = await postRoute(port, '/act', { ref: 'e5' }, token)
    expect(res.json).toEqual({ ok: false, error: 'usage' })
    expect(controller.click).not.toHaveBeenCalled()
  })

  it('启动时写入 runtime/app-ui.json', async () => {
    const { token } = await startWithEphemeralPort()
    const runtimePath = path.join(tmpRoot, 'runtime', 'app-ui.json')
    expect(fs.existsSync(runtimePath)).toBe(true)
    const written = JSON.parse(fs.readFileSync(runtimePath, 'utf-8'))
    expect(written.port).toBe(port)
    expect(written.token).toBe(token)
    expect(typeof written.startedAt).toBe('string')
  })

  it('停止时删除 runtime/app-ui.json', async () => {
    await startWithEphemeralPort()
    const runtimePath = path.join(tmpRoot, 'runtime', 'app-ui.json')
    expect(fs.existsSync(runtimePath)).toBe(true)
    await stopAppUiControlServer()
    expect(fs.existsSync(runtimePath)).toBe(false)
  })
})

describe('POST /command', () => {
  let tmpRoot: string
  let controller: AppUiController
  let port: number

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-app-ui-server-'))
    _resetWindowsClientDataRootCacheForTest()
    process.env.LUMII_CLIENT_DATA_DIR = tmpRoot
    controller = mockController()
    port = 0
    mockedInspectPortUsage.mockReset()
  })

  afterEach(async () => {
    await stopAppUiControlServer()
    delete process.env.LUMII_CLIENT_DATA_DIR
    _resetWindowsClientDataRootCacheForTest()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  /** 用给定 deps 覆盖启动一个控制口，返回 token/port */
  async function startWith(
    extraDeps: Partial<Parameters<typeof startAppUiControlServer>[0]>,
  ): Promise<{ token: string; port: number }> {
    const server = http.createServer()
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('no port')
    port = addr.port
    server.close()

    const config = await startAppUiControlServer({
      getWindow: () => null,
      controller,
      port,
      token: 'test-token-123',
      ...extraDeps,
    })
    return { token: config.token, port: config.port }
  }

  it('白名单外返回 not_exposed 且不调用 dispatchCommand', async () => {
    const dispatchCommand = vi.fn(async () => ({ ok: true }))
    const { token } = await startWith({ dispatchCommand })

    const res = await postRoute(port, '/command', { type: 'mcp:writeConfigFile', content: '{}' }, token)
    expect(res.json).toEqual({ ok: false, error: 'not_exposed' })
    expect(dispatchCommand).not.toHaveBeenCalled()
  })

  it('白名单内透传 dispatchCommand 返回值', async () => {
    const dispatchCommand = vi.fn(async () => ({ status: 'ok', jobs: [] }))
    const { token } = await startWith({ dispatchCommand })

    const res = await postRoute(port, '/command', { type: 'cron:list' }, token)
    expect(res.json).toEqual({ status: 'ok', jobs: [] })
    expect(dispatchCommand).toHaveBeenCalledWith({ type: 'cron:list' })
  })

  it('并发两个 /command 串行执行', async () => {
    const order: string[] = []
    let callCount = 0
    const dispatchCommand = vi.fn(async () => {
      const id = ++callCount
      order.push(`start:${id}`)
      await new Promise((r) => setTimeout(r, 30))
      order.push(`end:${id}`)
      return { ok: true }
    })
    const { token } = await startWith({ dispatchCommand })

    await Promise.all([
      postRoute(port, '/command', { type: 'cron:list' }, token),
      postRoute(port, '/command', { type: 'cron:list' }, token),
    ])

    expect(order).toEqual(['start:1', 'end:1', 'start:2', 'end:2'])
  })

  it('总开关关闭时任意路由返回 disabled', async () => {
    const { token } = await startWith({
      readSettingsJson: async () =>
        JSON.stringify({ privacy: { allowAgentAppUiControl: false } }),
    })

    const res = await postRoute(port, '/screenshot', {}, token)
    expect(res.json).toEqual({ ok: false, error: 'disabled' })
    expect(controller.screenshot).not.toHaveBeenCalled()
  })

  it('超速率限制返回 rate_limited', async () => {
    let allowed = true
    const { token } = await startWith({
      rateLimiter: { tryConsume: () => allowed },
    })

    const first = await postRoute(port, '/screenshot', {}, token)
    expect(first.json).toMatchObject({ ok: true })

    allowed = false
    const second = await postRoute(port, '/screenshot', {}, token)
    expect(second.json).toEqual({ ok: false, error: 'rate_limited' })
  })
})
