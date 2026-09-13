import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { stripUserEcho } from './coding-dev-acp-run.js'
import {
  resolveAcpTimeoutMs,
  ACP_TIMEOUT_ENV_VAR,
  DEFAULT_ACP_TIMEOUT_MS,
} from './coding-dev-backends-stub/acp-config.js'

describe('stripUserEcho', () => {
  it('移除开头回显的用户输入', () => {
    expect(stripUserEcho('你好\n\n你好！有什么可以帮你的？', '你好')).toBe('你好！有什么可以帮你的？')
  })

  it('回显前有空白也能识别', () => {
    expect(stripUserEcho('\n  切换后端\n结果如下', '切换后端')).toBe('结果如下')
  })

  it('不以用户输入开头时原样返回', () => {
    expect(stripUserEcho('好的，你好', '你好')).toBe('好的，你好')
  })

  it('用户输入为空时原样返回', () => {
    expect(stripUserEcho('  你好', '   ')).toBe('  你好')
  })

  it('整段都是回显时返回空串', () => {
    expect(stripUserEcho('你好', '你好')).toBe('')
  })
})

describe('resolveAcpTimeoutMs', () => {
  const original = process.env[ACP_TIMEOUT_ENV_VAR]

  afterEach(() => {
    if (original === undefined) delete process.env[ACP_TIMEOUT_ENV_VAR]
    else process.env[ACP_TIMEOUT_ENV_VAR] = original
  })

  it('未设置时回落默认 60 分钟', () => {
    delete process.env[ACP_TIMEOUT_ENV_VAR]
    expect(resolveAcpTimeoutMs()).toBe(DEFAULT_ACP_TIMEOUT_MS)
  })

  it('设为 0 表示不限制', () => {
    process.env[ACP_TIMEOUT_ENV_VAR] = '0'
    expect(resolveAcpTimeoutMs()).toBeUndefined()
  })

  it('非法值回落默认值', () => {
    process.env[ACP_TIMEOUT_ENV_VAR] = 'abc'
    expect(resolveAcpTimeoutMs()).toBe(DEFAULT_ACP_TIMEOUT_MS)
  })
})
