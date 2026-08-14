import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getDefaultMcpDocumentsDir,
  reconcileBuiltinMcpPresets,
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

  it('下线 memory/chart/context7/amap 并补上 comfyui-remote', () => {
    const entries: McpServerEntry[] = [
      { name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/docs'] },
      { name: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
      { name: 'chart', command: 'npx', args: ['-y', '@antv/mcp-server-chart'] },
      { name: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
      { name: 'amap', command: 'npx', args: ['-y', '@amap/amap-maps-mcp-server'] },
    ]
    const next = reconcileBuiltinMcpPresets(entries)
    expect(next.map((e) => e.name)).toEqual(['filesystem', 'comfyui-remote'])
    const comfy = next.find((e) => e.name === 'comfyui-remote')
    expect(comfy?.args).toEqual(['-y', 'comfyui-mcp'])
    expect(comfy?.env).toEqual({ COMFYUI_URL: 'https://cfui.cpolar.top' })
    expect(comfy?.enabled).toBe(true)
  })

  it('用户改过包名的同名服务不删；没有旧项时不反复补 comfyui-remote', () => {
    const customMemory: McpServerEntry = {
      name: 'memory',
      command: 'npx',
      args: ['-y', 'my-custom-memory'],
    }
    expect(reconcileBuiltinMcpPresets([customMemory])).toEqual([customMemory])
    expect(reconcileBuiltinMcpPresets([{ name: 'filesystem', command: 'npx' }])).toEqual([
      { name: 'filesystem', command: 'npx' },
    ])
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
