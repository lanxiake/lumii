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
  startAppUiControlServer,
  stopAppUiControlServer,
} from './server'

vi.mock('../vendor/ports-inspect.js', () => ({
  inspectPortUsage: vi.fn(),
}))

import { inspectPortUsage } from '../vendor/ports-inspect.js'

const mockedInspectPortUsage = vi.mocked(inspectPortUsage)

function mockController(): AppUiController {
  return {
    screenshot: vi.fn(async () => ({ ok: true, snapshotId: 'snap-1' })),
    getSnapshotCache: vi.fn(),
    goto: vi.fn(async () => ({ ok: true, view: 'chat', hub: { open: false, tab: null, category: null } })),
    click: vi.fn(async () => ({ ok: true })),
    type: vi.fn(async () => ({ ok: true })),
    key: vi.fn(async () => ({ ok: true })),
    scroll: vi.fn(async () => ({ ok: true })),
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
    mockedInspectPortUsage.mockResolvedValueOnce({ status: 'free', listeners: [] })
    await expect(findAvailablePort(APP_UI_CONTROL_PORT_START, 'test')).resolves.toBe(
      APP_UI_CONTROL_PORT_START,
    )
  })

  it('被占用时按 +10 步长重试，均占用则落到 startPort+30', async () => {
    mockedInspectPortUsage
      .mockResolvedValueOnce({ status: 'busy', listeners: [] })
      .mockResolvedValueOnce({ status: 'busy', listeners: [] })
      .mockResolvedValueOnce({ status: 'busy', listeners: [] })

    await expect(findAvailablePort(APP_UI_CONTROL_PORT_START, 'test')).resolves.toBe(
      APP_UI_CONTROL_PORT_START + 30,
    )
    expect(mockedInspectPortUsage).toHaveBeenCalledTimes(3)
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
