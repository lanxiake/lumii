import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getDefaultMcpDocumentsDir,
  resolveMcpEntryPaths,
  type McpServerEntry,
} from './mcp-config'

describe('MCP filesystem 路径解析', () => {
  it('默认文档目录存在且可读', () => {
    const dir = getDefaultMcpDocumentsDir()
    expect(fs.existsSync(dir)).toBe(true)
    expect(fs.statSync(dir).isDirectory()).toBe(true)
  })

  it('把 {{USER_DOCUMENTS}} 与历史 D:/Documents 解析为本机真实目录', () => {
    const expected = getDefaultMcpDocumentsDir()
    for (const token of ['{{USER_DOCUMENTS}}', 'D:/Documents', 'D:\\Documents']) {
      const entry: McpServerEntry = {
        name: 'filesystem',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', token],
        enabled: true,
      }
      const resolved = resolveMcpEntryPaths(entry)
      expect(resolved.args?.at(-1)).toBe(expected)
      expect(resolved.args?.at(-1)).not.toBe(token)
    }
  })

  it('不改动用户自定义的其它目录参数', () => {
    const custom = path.join(os.homedir(), 'Projects')
    const entry: McpServerEntry = {
      name: 'filesystem',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', custom],
    }
    expect(resolveMcpEntryPaths(entry)).toBe(entry)
  })
})
