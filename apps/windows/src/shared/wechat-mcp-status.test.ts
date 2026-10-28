import { describe, expect, it, vi } from 'vitest'

import {
  bareToolName,
  evaluateWechatMcp,
  isWechatMcpUsable,
  WECHAT_MCP_MIN_VERSION,
  WECHAT_MCP_REQUIRED_TOOLS,
} from './wechat-mcp-status'

/**
 * 工具名照侧车实际交出的写法（裸名，不带 `mcp__` 前缀）——那正是迁移后的形态。
 * 带前缀的老写法另有一条用例守着（`bareToolName` 仍然剥）。
 */
const FULL_TOOLS = [...WECHAT_MCP_REQUIRED_TOOLS]

describe('bareToolName', () => {
  it('剥掉 mcp__<server>__ 前缀，裸名原样返回', () => {
    expect(bareToolName('mcp__wechat-chat__poll_new')).toBe('poll_new')
    expect(bareToolName('poll_new')).toBe('poll_new')
  })
})

describe('evaluateWechatMcp（判的是扩展启用 + 侧车就绪，不再是 MCP 配置）', () => {
  it('扩展没启用：排最前，把人指到设置里的扩展开关', () => {
    const v = evaluateWechatMcp({ pluginEnabled: false, sidecarReady: false })
    expect(v.state).toBe('not-configured')
    expect(v.label).toBe('未启用')
    expect(v.hint).toContain('本机微信')
  })

  it('启用了但侧车没起来：未就绪，并原样转述失败原因', () => {
    const v = evaluateWechatMcp({
      pluginEnabled: true,
      sidecarReady: false,
      lastError: '未能从微信进程内存取到数据库密钥',
    })
    expect(v.state).toBe('not-connected')
    expect(v.hint).toContain('数据库密钥')
  })

  it('侧车起来了但缺关键工具 ⇒ 不完整（判据是工具，不是版本号）', () => {
    const v = evaluateWechatMcp({
      pluginEnabled: true,
      sidecarReady: true,
      serverVersion: '9.9.9', // 版本再高也没用：缺工具就是不能用
      tools: ['poll_new', 'read_history'],
    })
    expect(v.state).toBe('incompatible')
    expect(v.missingTools).toEqual(['send_text', 'check_env', 'locate_db'])
    expect(isWechatMcpUsable(v.state)).toBe(false)
  })

  it('工具齐全 ⇒ ready，版本只作提示', () => {
    const v = evaluateWechatMcp({
      pluginEnabled: true,
      sidecarReady: true,
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
      pluginEnabled: true,
      sidecarReady: true,
      serverVersion: '0.9.0',
      tools: FULL_TOOLS,
    })
    expect(v.outdated).toBe(true)
    expect(v.label).toContain(WECHAT_MCP_MIN_VERSION)
    expect(v.state).toBe('ready')
  })

  it('侧车不报版本：不编版本，也不判 outdated', () => {
    const v = evaluateWechatMcp({ pluginEnabled: true, sidecarReady: true, tools: FULL_TOOLS })
    expect(v.state).toBe('ready')
    expect(v.outdated).toBe(false)
    expect(v.label).toBe('已就绪')
  })

  it('工具名带老式 mcp__ 前缀也认（老写法兼容）', () => {
    const v = evaluateWechatMcp({
      pluginEnabled: true,
      sidecarReady: true,
      tools: FULL_TOOLS.map((t) => `mcp__wechat-chat__${t}`),
    })
    expect(v.state).toBe('ready')
  })

  it('比较器可注入（默认按数字比，不依赖调用方实现细节）', () => {
    const compare = vi.fn(() => -1)
    const v = evaluateWechatMcp({
      pluginEnabled: true,
      sidecarReady: true,
      serverVersion: '1.0.0',
      tools: FULL_TOOLS,
      compare,
    })
    expect(compare).toHaveBeenCalledWith('1.0.0', WECHAT_MCP_MIN_VERSION)
    expect(v.outdated).toBe(true)
  })
})
