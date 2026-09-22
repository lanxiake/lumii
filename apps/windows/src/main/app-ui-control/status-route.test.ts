/**
 * @vitest-environment node
 */
/**
 * `/status` 的「提供商是否就绪」判定。
 *
 * 两条容易写错、写错了用户又很难自己看出来的分支：
 *
 * 1. `loadProviderConfig()` 永远返回对象（字段都有默认值），必须按
 *    「启用 + 有模型 ID + 非本地类型需有 Key」判断，否则空配置也会报「已配置」；
 * 2. 「有密文但解不开」必须与「没填过」分开说——这是无头/无人值守部署最容易撞上的情况
 *    （凭据在桌面会话里加密落盘，换到密钥环没解锁的环境读不出来）。只说「未配置」，
 *    用户会以为自己从没填过，反复重填、重启，而真因在密钥环。
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetWindowsClientDataRootCacheForTest } from '../client-data-root'
import type { LocalProviderConfigView } from '../provider-config'

const { loadProviderConfigMock } = vi.hoisted(() => ({ loadProviderConfigMock: vi.fn() }))

// 只替换 /status 用到的那一个入口；其余导出本文件不触发
vi.mock('../provider-config', () => ({
  loadProviderConfig: () => loadProviderConfigMock(),
}))

import { startAppUiControlServer, stopAppUiControlServer } from './server'

/** 造一份 chat 槽视图；只填 /status 会读的字段 */
function chatView(overrides: Partial<LocalProviderConfigView> = {}): LocalProviderConfigView {
  return {
    enabled: true,
    type: 'openai',
    modelId: 'gpt-4o-mini',
    apiKey: 'sk-test',
    baseUrl: 'https://api.openai.com',
    allowedModelIds: [],
    apiFormat: 'completions',
    contextWindowK: {},
    modelReasoning: {},
    thinkingFormat: 'auto',
    ...overrides,
  } as LocalProviderConfigView
}

describe('POST /status 的提供商判定', () => {
  let tmpRoot: string
  let port: number
  let token: string

  async function post(body: unknown): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body ?? {})
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/status',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
            Authorization: `Bearer ${token}`,
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf-8')) }),
          )
        },
      )
      req.on('error', reject)
      req.write(payload)
      req.end()
    })
  }

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-status-route-'))
    _resetWindowsClientDataRootCacheForTest()
    process.env.LUMII_CLIENT_DATA_DIR = tmpRoot
    delete process.env.LUMII_BROWSER_EXECUTABLE
    delete process.env.LUMII_BROWSER_NO_SANDBOX
    loadProviderConfigMock.mockReset()

    // 取一个空闲端口再交给控制口（与 server.test.ts 同一手法）
    const probe = http.createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
    const addr = probe.address()
    if (!addr || typeof addr === 'string') throw new Error('no port')
    port = addr.port
    probe.close()

    const config = await startAppUiControlServer({
      getWindow: () => null,
      // 本文件只测 /status，不碰 controller 的能力
      controller: {} as never,
      port,
      token: 'test-token-status',
    })
    token = config.token
    port = config.port
  })

  afterEach(async () => {
    await stopAppUiControlServer()
    delete process.env.LUMII_CLIENT_DATA_DIR
    _resetWindowsClientDataRootCacheForTest()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('启用 + 有模型 + 有 Key → 已配置，且不出现配置类推荐', async () => {
    loadProviderConfigMock.mockReturnValue(chatView())

    const res = await post({})

    expect(res.status).toBe(200)
    expect(res.json.configuration.hasProviders).toBe(true)
    expect(res.json.configuration.apiKeyDecryptFailed).toBe(false)
    expect(res.json.recommendations.join('\n')).not.toContain('未配置 AI 模型提供商')
  })

  it('没有 API Key（非本地类型）→ 未配置，推荐跑 setup', async () => {
    // loadProviderConfig() 永远返回对象：不判 Key 就会把「空配置」当成已配置
    loadProviderConfigMock.mockReturnValue(chatView({ apiKey: '' }))

    const res = await post({})

    expect(res.json.configuration.hasProviders).toBe(false)
    expect(res.json.recommendations.join('\n')).toContain('未配置 AI 模型提供商')
  })

  it('本地服务（ollama/lmstudio）没 Key 也算已配置', async () => {
    loadProviderConfigMock.mockReturnValue(chatView({ type: 'ollama', apiKey: '' }))

    const res = await post({})

    expect(res.json.configuration.hasProviders).toBe(true)
  })

  it('只有模型 ID 但没启用 → 未配置', async () => {
    loadProviderConfigMock.mockReturnValue(chatView({ enabled: false }))

    const res = await post({})

    expect(res.json.configuration.hasProviders).toBe(false)
  })

  it('密钥解不开 → 报「解密失败」而不是「未配置」，并给出重填命令', async () => {
    loadProviderConfigMock.mockReturnValue(
      chatView({ apiKey: '', apiKeyDecryptFailed: true }),
    )

    const res = await post({})
    const recommendations = res.json.recommendations.join('\n')

    expect(res.json.configuration.apiKeyDecryptFailed).toBe(true)
    expect(recommendations).toContain('解密失败')
    expect(recommendations).toContain('provider set')
    // 「未配置」会把用户引向「我明明填过」的死循环，这条必须让位给具体原因
    expect(recommendations).not.toContain('未配置 AI 模型提供商')
  })

  it('读配置抛错时不冒充已配置（保持 false）', async () => {
    loadProviderConfigMock.mockImplementation(() => {
      throw new Error('boom')
    })

    const res = await post({})

    expect(res.json.configuration.hasProviders).toBe(false)
    expect(res.json.configuration.apiKeyDecryptFailed).toBe(false)
  })
})
