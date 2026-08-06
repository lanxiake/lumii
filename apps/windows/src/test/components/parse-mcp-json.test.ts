import { describe, expect, it } from 'vitest'
import { parseMcpJson } from '../../renderer/components/McpServersPanel/parse-mcp-json'

describe('parseMcpJson', () => {
  it('解析标准 mcpServers 格式（多个）', () => {
    const result = parseMcpJson(JSON.stringify({
      mcpServers: {
        filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/'] },
        github: { command: 'npx', env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } },
      },
    }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entries).toHaveLength(2)
    expect(result.entries[0]).toEqual({
      name: 'filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/'],
    })
    expect(result.entries[1]?.env).toEqual({ GITHUB_TOKEN: '${GITHUB_TOKEN}' })
  })

  it('解析裸对象与单条带 name 两种简写', () => {
    const bare = parseMcpJson('{"fs":{"command":"uvx","args":["mcp-fs"]}}')
    expect(bare.ok && bare.entries[0]?.name).toBe('fs')

    const single = parseMcpJson('{"name":"fs","command":"uvx"}')
    expect(single.ok && single.entries).toHaveLength(1)
  })

  it('解析数组格式', () => {
    const result = parseMcpJson('[{"name":"a","command":"x"},{"name":"b","command":"y"}]')
    expect(result.ok && result.entries.map((e) => e.name)).toEqual(['a', 'b'])
  })

  it('缺少 command 时报错，不静默产出半个配置', () => {
    const result = parseMcpJson('{"mcpServers":{"broken":{"args":["x"]}}}')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('command')
  })

  it('拒绝空内容、坏 JSON 和错误的 args 类型', () => {
    expect(parseMcpJson('   ').ok).toBe(false)
    expect(parseMcpJson('{oops}').ok).toBe(false)
    expect(parseMcpJson('{"mcpServers":{}}').ok).toBe(false)
    expect(parseMcpJson('{"a":{"command":"x","args":"nope"}}').ok).toBe(false)
  })
})
