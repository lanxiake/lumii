import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyPresetDefaults,
  computeMcpPresetBackfill,
  computeBackgroundToolNames,
  getDefaultMcpDocumentsDir,
  reconcileBuiltinMcpPresets,
  resolveMcpEntryPaths,
  validateMcpServerEntry,
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

  it('下线 memory/chart/context7/amap/firecrawl/baidu-map 并补上 comfyui-remote', () => {
    const entries: McpServerEntry[] = [
      { name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/docs'] },
      { name: 'memory', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
      { name: 'chart', command: 'npx', args: ['-y', '@antv/mcp-server-chart'] },
      { name: 'context7', command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
      { name: 'amap', command: 'npx', args: ['-y', '@amap/amap-maps-mcp-server'] },
      { name: 'firecrawl-mcp', command: 'npx', args: ['-y', 'firecrawl-mcp'] },
      { name: 'baidu-map', command: 'npx', args: ['-y', '@baidumap/mcp-server-baidu-map'] },
    ]
    const next = reconcileBuiltinMcpPresets(entries)
    expect(next.map((e) => e.name)).toEqual(['comfyui-remote'])
    const comfy = next.find((e) => e.name === 'comfyui-remote')
    expect(comfy?.args).toEqual(['-y', 'comfyui-mcp'])
    expect(comfy?.env).toEqual({ COMFYUI_URL: 'https://cfui.cpolar.top' })
    expect(comfy?.enabled).toBe(false)
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
      { name: 'excel-mcp', command: 'npx', args: ['-y', 'excel-mcp'] },
    ]
    expect(reconcileBuiltinMcpPresets(entries).map((e) => e.name)).toEqual(['excel-mcp'])
  })

  it('下线官方 filesystem MCP，用户自建同名服务不删', () => {
    const official: McpServerEntry[] = [
      { name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/docs'] },
      { name: 'excel-mcp', command: 'npx', args: ['-y', 'excel-mcp'] },
    ]
    expect(reconcileBuiltinMcpPresets(official).map((e) => e.name)).toEqual(['excel-mcp'])

    const custom: McpServerEntry = {
      name: 'filesystem',
      command: 'npx',
      args: ['-y', 'my-custom-filesystem', 'C:/docs'],
    }
    expect(reconcileBuiltinMcpPresets([custom])).toEqual([custom])
  })
})

describe('新增内置项补给老用户', () => {
  it('只补没推过且当前没有的，要密钥的补进来默认停用', () => {
    const seeded = new Set(['excel-mcp'])
    const entries: McpServerEntry[] = [{ name: 'excel-mcp', command: 'npx', args: ['-y', 'excel-mcp'] }]
    const { added } = computeMcpPresetBackfill(entries, seeded)

    const names = added.map((e) => e.name)
    expect(names).toContain('12306-mcp')
    expect(names).toContain('amap-maps')
    expect(names).toContain('comfyui-remote')
    expect(names).not.toContain('filesystem')

    expect(added.find((e) => e.name === '12306-mcp')?.enabled).toBe(true)
    expect(added.find((e) => e.name === 'comfyui-remote')?.enabled).toBe(false)
    expect(added.find((e) => e.name === 'mcp-trends-hub')?.enabled).toBe(true)
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

describe('MCP 请求超时配置', () => {
  it('comfyui-remote 预置带 6 分钟超时，随播种落到配置条目', () => {
    const comfy = computeMcpPresetBackfill([], new Set()).added.find((e) => e.name === 'comfyui-remote')
    expect(comfy?.timeoutMs).toBe(360_000)
  })

  it('timeoutMs 非正整数时校验拦下', () => {
    expect(validateMcpServerEntry({ name: 'x', command: 'npx', timeoutMs: 0 })).toMatch(/正整数/)
    expect(validateMcpServerEntry({ name: 'x', command: 'npx', timeoutMs: -1 })).toMatch(/正整数/)
    expect(validateMcpServerEntry({ name: 'x', command: 'npx', timeoutMs: Number.NaN })).toMatch(/正整数/)
    expect(validateMcpServerEntry({ name: 'x', command: 'npx', timeoutMs: 60_000 })).toBeNull()
  })
})

describe('MCP 后台化工具配置', () => {
  it('comfyui-remote 预置标记 enqueue_workflow 后台化', () => {
    const comfy = computeMcpPresetBackfill([], new Set()).added.find((e) => e.name === 'comfyui-remote')
    expect(comfy?.backgroundTools).toEqual(['enqueue_workflow'])
  })

  it('computeBackgroundToolNames 拼出完整工具名（未配的 Server 不出现在集合里）', () => {
    const names = computeBackgroundToolNames([
      { name: 'comfyui-remote', backgroundTools: ['enqueue_workflow'] },
      { name: 'other', backgroundTools: ['run'] },
      { name: 'plain' },
    ])
    expect([...names].sort()).toEqual([
      'mcp__comfyui-remote__enqueue_workflow',
      'mcp__other__run',
    ])
  })

  it('backgroundTools 非数组时校验拦下', () => {
    expect(
      validateMcpServerEntry({ name: 'x', command: 'npx', backgroundTools: 'nope' as never }),
    ).toMatch(/字符串数组/)
  })

  it('applyPresetDefaults：老配置缺字段时用预置补齐，用户显式值优先', () => {
    const preset = MCP_PRESETS.find((p) => p.name === 'comfyui-remote')
    // 老用户条目：只有 command/args/env，没有 timeoutMs/backgroundTools
    const legacy: McpServerEntry = { name: 'comfyui-remote', command: 'npx', args: ['-y', 'comfyui-mcp'] }
    const filled = applyPresetDefaults(legacy, preset)
    expect(filled.timeoutMs).toBe(360_000)
    expect(filled.backgroundTools).toEqual(['enqueue_workflow'])

    // 用户已配的值不被覆盖
    const overridden = applyPresetDefaults(
      { ...legacy, timeoutMs: 1_000, backgroundTools: ['custom_tool'] },
      preset,
    )
    expect(overridden.timeoutMs).toBe(1_000)
    expect(overridden.backgroundTools).toEqual(['custom_tool'])

    // 非内置 Server 无预设，原样返回
    const custom: McpServerEntry = { name: 'my-mcp', command: 'npx' }
    expect(applyPresetDefaults(custom, undefined)).toBe(custom)
  })
})
