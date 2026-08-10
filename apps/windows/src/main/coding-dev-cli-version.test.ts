/**
 * coding-dev-cli-version 单元测试
 *
 * detectToolVersion 依赖 child_process.execFile，fetchNpmLatestVersion 依赖 node:https，
 * 都 mock 掉外部依赖，只验证解析逻辑和失败静默降级。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const execFileMock = vi.fn()
vi.mock('node:child_process', () => {
  const mod = { execFile: (...args: unknown[]) => execFileMock(...args) }
  return { default: mod, ...mod }
})

const httpsGetMock = vi.fn()
vi.mock('node:https', () => {
  const mod = { get: (...args: unknown[]) => httpsGetMock(...args) }
  return { default: mod, ...mod }
})

const { detectToolVersion, fetchNpmLatestVersion } = await import('./coding-dev-cli-version')

describe('detectToolVersion', () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })

  it('从 stdout 提取语义化版本号', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, 'claude-code 1.2.3\n', '')
    })
    const result = await detectToolVersion('/usr/bin/claude')
    expect(result).toBe('1.2.3')
  })

  it('stdout 没有版本号但 stderr 有时也能提取', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, '', 'version: 2.0.1')
    })
    const result = await detectToolVersion('/usr/bin/tool')
    expect(result).toBe('2.0.1')
  })

  it('命令执行失败时返回 undefined，不抛出', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(new Error('ENOENT'), '', '')
    })
    const result = await detectToolVersion('/usr/bin/missing')
    expect(result).toBeUndefined()
  })

  it('输出里没有版本号格式时返回 undefined', async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(null, 'no version info here', '')
    })
    const result = await detectToolVersion('/usr/bin/tool')
    expect(result).toBeUndefined()
  })

  it('--version 不支持时回退到 -v', async () => {
    execFileMock.mockImplementation((_cmd, args, _opts, cb) => {
      if (args[0] === '--version') cb(new Error('unknown flag'), '', '')
      else cb(null, 'tool v3.4.5', '')
    })
    const result = await detectToolVersion('/usr/bin/tool')
    expect(result).toBe('3.4.5')
  })
})

describe('fetchNpmLatestVersion', () => {
  beforeEach(() => {
    httpsGetMock.mockReset()
  })

  /** 构造一个假的 http.IncomingMessage：可读流 + statusCode */
  function fakeResponse(statusCode: number, body: string) {
    const res = new EventEmitter() as EventEmitter & { statusCode: number; resume: () => void }
    res.statusCode = statusCode
    res.resume = () => undefined
    queueMicrotask(() => {
      res.emit('data', Buffer.from(body))
      res.emit('end')
    })
    return res
  }

  function fakeRequest() {
    return { on: vi.fn(), setTimeout: vi.fn() }
  }

  it('成功返回 JSON 里的 version 字段', async () => {
    httpsGetMock.mockImplementation((_url, _opts, cb) => {
      cb(fakeResponse(200, JSON.stringify({ version: '1.5.0' })))
      return fakeRequest()
    })
    const result = await fetchNpmLatestVersion('@anthropic-ai/claude-code')
    expect(result).toBe('1.5.0')
  })

  it('HTTP 非 200 时返回 undefined', async () => {
    httpsGetMock.mockImplementation((_url, _opts, cb) => {
      cb(fakeResponse(404, ''))
      return fakeRequest()
    })
    const result = await fetchNpmLatestVersion('not-exist-package')
    expect(result).toBeUndefined()
  })

  it('JSON 解析失败时返回 undefined', async () => {
    httpsGetMock.mockImplementation((_url, _opts, cb) => {
      cb(fakeResponse(200, 'not json'))
      return fakeRequest()
    })
    const result = await fetchNpmLatestVersion('pkg')
    expect(result).toBeUndefined()
  })

  it('请求抛出异常时返回 undefined', async () => {
    httpsGetMock.mockImplementation(() => {
      throw new Error('network down')
    })
    const result = await fetchNpmLatestVersion('pkg')
    expect(result).toBeUndefined()
  })
})
