/**
 * coding-dev-cli-version 单元测试
 *
 * detectToolVersion 依赖 child_process.spawn，fetchNpmLatestVersion 依赖 node:https，
 * 都 mock 掉外部依赖，只验证解析逻辑和失败静默降级。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

class MockChildProcess extends EventEmitter {
  stdout = new Readable({ read() {} })
  stderr = new Readable({ read() {} })
  kill = vi.fn()
}

const spawnMock = vi.fn()
vi.mock('node:child_process', () => {
  const mod = { spawn: (...args: unknown[]) => spawnMock(...args) }
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
    spawnMock.mockReset()
  })

  it('从 stdout 提取语义化版本号', async () => {
    const child = new MockChildProcess()
    spawnMock.mockReturnValue(child)
    const promise = detectToolVersion('/usr/bin/claude')
    setImmediate(() => {
      child.stdout.push('claude-code 1.2.3\n')
      child.stdout.push(null)
      child.emit('close', 0)
    })
    const result = await promise
    expect(result).toBe('1.2.3')
  })

  it('stdout 没有版本号但 stderr 有时也能提取', async () => {
    const child = new MockChildProcess()
    spawnMock.mockReturnValue(child)
    const promise = detectToolVersion('/usr/bin/tool')
    setImmediate(() => {
      child.stderr.push('version: 2.0.1')
      child.stderr.push(null)
      child.emit('close', 0)
    })
    const result = await promise
    expect(result).toBe('2.0.1')
  })

  it('命令执行失败时返回 undefined，不抛出', async () => {
    spawnMock.mockImplementation(() => {
      const child = new MockChildProcess()
      setImmediate(() => {
        child.emit('error', new Error('ENOENT'))
      })
      return child
    })
    const result = await detectToolVersion('/usr/bin/missing')
    expect(result).toBeUndefined()
  })

  it('输出里没有版本号格式时返回 undefined', async () => {
    spawnMock.mockImplementation(() => {
      const child = new MockChildProcess()
      setImmediate(() => {
        child.stdout.push('no version info here')
        child.stdout.push(null)
        child.emit('close', 0)
      })
      return child
    })
    const result = await detectToolVersion('/usr/bin/tool')
    expect(result).toBeUndefined()
  })

  it('--version 不支持时回退到 -v', async () => {
    let callCount = 0
    spawnMock.mockImplementation(() => {
      const child = new MockChildProcess()
      callCount++
      if (callCount === 1) {
        setTimeout(() => child.emit('error', new Error('unknown flag')), 0)
      } else {
        setTimeout(() => {
          child.stdout.push('tool v3.4.5')
          child.stdout.push(null)
          child.emit('close', 0)
        }, 0)
      }
      return child
    })
    const result = await detectToolVersion('/usr/bin/tool')
    expect(result).toBe('3.4.5')
  })

  it('保留 Cursor 的日期版本与 build hash', async () => {
    const child = new MockChildProcess()
    spawnMock.mockReturnValue(child)
    const promise = detectToolVersion('/usr/bin/agent')
    setImmediate(() => {
      child.stdout.push('2026.07.23-e383d2b\n')
      child.stdout.push(null)
      child.emit('close', 0)
    })
    const result = await promise
    expect(result).toBe('2026.07.23-e383d2b')
  })

  it('保留语义化预发布后缀', async () => {
    const child = new MockChildProcess()
    spawnMock.mockReturnValue(child)
    const promise = detectToolVersion('/usr/bin/tool')
    setImmediate(() => {
      child.stdout.push('tool 1.2.3-beta.4')
      child.stdout.push(null)
      child.emit('close', 0)
    })
    const result = await promise
    expect(result).toBe('1.2.3-beta.4')
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
