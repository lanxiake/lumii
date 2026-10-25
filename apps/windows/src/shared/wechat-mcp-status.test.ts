import { describe, expect, it, vi } from 'vitest'

import {
  bareToolName,
  evaluateWechatMcp,
  isWechatMcpUsable,
  WECHAT_MCP_MIN_VERSION,
  WECHAT_MCP_REQUIRED_TOOLS,
} from './wechat-mcp-status'

const FULL_TOOLS = WECHAT_MCP_REQUIRED_TOOLS.map((t) => `mcp__wechat-chat__${t}`)

describe('bareToolName', () => {
  it('剥掉 mcp__<server>__ 前缀，裸名原样返回', () => {
    expect(bareToolName('mcp__wechat-chat__poll_new')).toBe('poll_new')
    expect(bareToolName('poll_new')).toBe('poll_new')
  })
})

describe('evaluateWechatMcp', () => {
  it('没配置：排最前（此时 enabled/connected 都是空值，说别的没意义）', () => {
    const v = evaluateWechatMcp({ configured: false, connected: false })
    expect(v.state).toBe('not-configured')
    expect(v.hint).toContain('设置 › MCP 服务')
  })

  it('配置在但关着：已停用，且不误报成未连接', () => {
    const v = evaluateWechatMcp({ configured: true, enabled: false, connected: false })
    expect(v.state).toBe('disabled')
  })

  it('启用了但没连上：未连接，并原样转述失败原因', () => {
    const v = evaluateWechatMcp({
      configured: true,
      enabled: true,
      connected: false,
      lastError: '未能从微信进程内存取到数据库密钥',
    })
    expect(v.state).toBe('not-connected')
    expect(v.hint).toContain('数据库密钥')
  })

  it('连上了但缺关键工具 ⇒ 不兼容（判据是工具，不是版本号）', () => {
    const v = evaluateWechatMcp({
      configured: true,
      enabled: true,
      connected: true,
      serverVersion: '9.9.9', // 版本再高也没用：缺工具就是不能用
      tools: ['mcp__wechat-chat__poll_new', 'mcp__wechat-chat__read_history'],
    })
    expect(v.state).toBe('incompatible')
    expect(v.missingTools).toEqual(['send_text', 'check_env', 'locate_db'])
    expect(isWechatMcpUsable(v.state)).toBe(false)
  })

  it('工具齐全 ⇒ ready，版本只作提示', () => {
    const v = evaluateWechatMcp({
      configured: true,
      enabled: true,
      connected: true,
      serverVersion: '0.10.0',
      tools: FULL_TOOLS,
    })
    expect(v.state).toBe('ready')
    expect(v.label).toBe('v0.10.0')
    expect(v.outdated).toBe(false)
    expect(isWechatMcpUsable(v.state)).toBe(true)
  })

  it('低于验证下限：标注 outdated，但**不**降级为不可用（工具齐就照跑）', () => {
    const v = evaluateWechatMcp({
      configured: true,
      enabled: true,
      connected: true,
      serverVersion: '0.9.0',
      tools: FULL_TOOLS,
    })
    expect(v.outdated).toBe(true)
    expect(v.label).toContain(WECHAT_MCP_MIN_VERSION)
    expect(v.state).toBe('ready')
  })

  it('对端不报版本：不编版本，也不判 outdated', () => {
    const v = evaluateWechatMcp({
      configured: true,
      enabled: true,
      connected: true,
      tools: FULL_TOOLS,
    })
    expect(v.state).toBe('ready')
    expect(v.outdated).toBe(false)
    expect(v.label).toBe('已连接')
  })

  it('工具名不带前缀也认（第三方客户端写配置时不写前缀）', () => {
    const v = evaluateWechatMcp({
      configured: true,
      enabled: true,
      connected: true,
      tools: [...WECHAT_MCP_REQUIRED_TOOLS],
    })
    expect(v.state).toBe('ready')
  })

  it('比较器可注入（默认按数字比，不依赖调用方实现细节）', () => {
    const compare = vi.fn(() => -1)
    const v = evaluateWechatMcp({
      configured: true,
      enabled: true,
      connected: true,
      serverVersion: '1.0.0',
      tools: FULL_TOOLS,
      compare,
    })
    expect(compare).toHaveBeenCalledWith('1.0.0', WECHAT_MCP_MIN_VERSION)
    expect(v.outdated).toBe(true)
  })
})
