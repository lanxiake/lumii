import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  computeMcpPresetBackfill,
  getDefaultMcpDocumentsDir,
  reconcileBuiltinMcpPresets,
  resolveMcpEntryPaths,
  type McpServerEntry,
} from './mcp-config'
import { MCP_PRESETS } from '../../shared/mcp-presets'

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

  it('下线 sequential-thinking，但不顺手补一个用户没要过的 comfyui-remote', () => {
    const entries: McpServerEntry[] = [
      { name: 'sequential-thinking', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
      { name: 'baidu-map', command: 'npx', args: ['-y', '@baidumap/mcp-server-baidu-map'] },
    ]
    expect(reconcileBuiltinMcpPresets(entries).map((e) => e.name)).toEqual(['baidu-map'])
  })
})

describe('新增内置项补给老用户', () => {
  it('只补没推过且当前没有的，要密钥的补进来默认停用', () => {
    const seeded = new Set(['filesystem', 'comfyui-remote', 'baidu-map'])
    const entries: McpServerEntry[] = [{ name: 'filesystem', command: 'npx', args: ['-y', 'x'] }]
    const { added } = computeMcpPresetBackfill(entries, seeded)

    const names = added.map((e) => e.name)
    expect(names).toContain('excel-mcp')
    expect(names).toContain('firecrawl-mcp')
    expect(names).not.toContain('filesystem')

    expect(added.find((e) => e.name === 'firecrawl-mcp')?.enabled).toBe(false)
    expect(added.find((e) => e.name === 'excel-mcp')?.enabled).toBe(true)
  })

  it('推过一次就记档，用户删掉后不再回来', () => {
    const first = computeMcpPresetBackfill([], new Set())
    expect(first.added.length).toBe(MCP_PRESETS.length)

    // 用户把补进来的全删了，第二次不该再补
    const second = computeMcpPresetBackfill([], new Set(first.seededNext))
    expect(second.added).toEqual([])
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
