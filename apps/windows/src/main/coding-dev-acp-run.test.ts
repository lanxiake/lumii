import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { stripUserEcho, buildAcpAssistantContent, type CollectedToolCall } from './coding-dev-acp-run.js'
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

describe('buildAcpAssistantContent', () => {
  const call = (over: Partial<CollectedToolCall> = {}): CollectedToolCall => ({
    id: 't1',
    name: 'Read',
    args: { file_path: 'a.ts' },
    status: 'done',
    startedAt: 1_700_000_000_000,
    textPositionAtStart: 0,
    ...over,
  })

  it('工具在前、正文在后，正文成为一个 text part', () => {
    const content = buildAcpAssistantContent('m1', '改完了', [call(), call({ id: 't2', name: 'Bash' })])
    expect(content.type).toBe('assistant_parts')
    expect(content.parts.map((p) => p.type)).toEqual(['tool', 'tool', 'text'])
    expect(content.parts[2]).toMatchObject({ type: 'text', text: '改完了', status: 'done' })
  })

  it('工具的结果与失败态透传下去', () => {
    const content = buildAcpAssistantContent('m1', '', [
      call({ result: 'ok' }),
      call({ id: 't2', status: 'error', isError: true, result: 'boom' }),
    ])
    expect(content.parts[0]).toMatchObject({ type: 'tool', result: 'ok', status: 'done' })
    expect(content.parts[1]).toMatchObject({ type: 'tool', isError: true, result: 'boom', status: 'error' })
    // result 缺省时不该凭空造一个 result 字段
    expect('result' in (content.parts[0] as Record<string, unknown>)).toBe(true)
  })

  it('没收尾的工具（中止/崩溃）落成 interrupted，而不是看起来还在跑', () => {
    const content = buildAcpAssistantContent('m1', '（执行超时）', [call({ status: 'running' })])
    expect(content.parts[0]).toMatchObject({ status: 'interrupted' })
  })

  it('正文为空时不落 text part——但工具过程本身仍要落库', () => {
    const content = buildAcpAssistantContent('m1', '', [call()])
    expect(content.parts).toHaveLength(1)
    expect(content.parts[0]?.type).toBe('tool')
  })

  it('既无正文也无工具时 parts 为空（调用方据此跳过落库）', () => {
    expect(buildAcpAssistantContent('m1', '', []).parts).toHaveLength(0)
  })
})
