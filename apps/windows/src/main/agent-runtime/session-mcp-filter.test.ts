/**
 * 会话级 MCP 过滤：tools 参数与 systemPrompt hints 必须同源
 *
 * 两处不一致时，systemPrompt 会宣告一个实际不可调用的 server，
 * 模型据此发起调用后拿到「工具不存在」，属于最难排查的一类故障。
 */

import { describe, expect, it } from 'vitest'

/** 与 bridge-instance-factory 中的判定同构 */
const isDisabledMcpTool = (disabled: readonly string[], name: string): boolean =>
  disabled.some((server) => name.startsWith(`mcp__${server}__`))

const TOOLS = [
  'file_read',
  'mcp__ynote__createNote',
  'mcp__ynote__listNotes',
  'mcp__fs__read',
  'mcp__playwright__click',
]

describe('会话级 MCP 过滤', () => {
  it('只剔除被禁用 server 的工具，内置工具与其他 server 不受影响', () => {
    const kept = TOOLS.filter((n) => !isDisabledMcpTool(['ynote'], n))
    expect(kept).toEqual(['file_read', 'mcp__fs__read', 'mcp__playwright__click'])
  })

  it('空禁用集时全部保留', () => {
    expect(TOOLS.filter((n) => !isDisabledMcpTool([], n))).toEqual(TOOLS)
  })

  it('禁用多个 server', () => {
    const kept = TOOLS.filter((n) => !isDisabledMcpTool(['ynote', 'fs'], n))
    expect(kept).toEqual(['file_read', 'mcp__playwright__click'])
  })

  it('server 名前缀相同时不误伤（fs 不应命中 fsx）', () => {
    const tools = ['mcp__fs__read', 'mcp__fsx__read']
    expect(tools.filter((n) => !isDisabledMcpTool(['fs'], n))).toEqual(['mcp__fsx__read'])
  })

  it('tools 与 hints 同源：禁用集决定两边可见的 server 完全一致', () => {
    const disabled = ['ynote']
    const allServers = ['ynote', 'fs', 'playwright']
    // tools 侧：从工具名反推可见 server
    const serversFromTools = new Set(
      TOOLS.filter((n) => n.startsWith('mcp__') && !isDisabledMcpTool(disabled, n)).map(
        (n) => n.slice(5, n.indexOf('__', 5)),
      ),
    )
    // hints 侧：直接按名字过滤
    const serversFromHints = new Set(allServers.filter((s) => !disabled.includes(s)))
    expect([...serversFromTools].sort()).toEqual([...serversFromHints].sort())
  })
})
