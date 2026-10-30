/**
 * tool_search 的三条路径：命中并装载、命中但宿主无装载器、未命中。
 *
 * 这里的判据是「检索结果里有什么 + loadTools 收到什么」——**不是**「模型会不会用」，
 * 后者只能真机验（计划 C9 的单 Agent A/B）。
 */
import { describe, expect, it, vi } from 'vitest'
import { toolSearchToolConfig } from './tool-search-tool.js'
import type { ToolExecutionContext } from '../../types/tool.js'

const REGISTRY = [
  { name: 'file_write', description: '写入文件' },
  { name: 'autoreply_rules', description: 'Manage autoreply rules for channels' },
  { name: 'image_generate', description: '生成图片' },
]

function ctx(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    searchTools: (q) =>
      REGISTRY.filter((t) =>
        q
          .split(',')
          .map((g) => g.trim().toLowerCase())
          .some((term) => term && `${t.name} ${t.description}`.toLowerCase().includes(term)),
      ),
    ...overrides,
  } as never
}

async function run(params: { query: string }, context: ToolExecutionContext) {
  const result = await toolSearchToolConfig.execute('call-1', params, context)
  return JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>
}

describe('tool_search', () => {
  it('命中后把工具名交给 loadTools 装载，并如实说「下一轮可用」', async () => {
    const loadTools = vi.fn()
    const out = await run({ query: '写入, 图片' }, ctx({ loadTools }))
    expect(out.total).toBe(2)
    expect((out.tools as { name: string }[]).map((t) => t.name)).toEqual(['file_write', 'image_generate'])
    expect(loadTools).toHaveBeenCalledWith(['file_write', 'image_generate'])
    expect(out.loaded).toBe(true)
  })

  it('宿主没注入 loadTools 时仍返回命中结果，但明确标注未装载', async () => {
    const out = await run({ query: 'autoreply' }, ctx())
    expect(out.total).toBe(1)
    expect(out.loaded).toBe(false)
    expect(String(out.note)).toContain('not loaded')
  })

  it('未命中时给出「换个词再试」而不是让模型以为能力不存在', async () => {
    const out = await run({ query: '不存在的工具' }, ctx())
    expect(out.total).toBe(0)
    expect(String(out.hint)).toContain('different terms')
  })

  it('未命中也要调 loadTools([]) —— 宿主的 fail-open 靠这个空数组计数，不调安全网就是假的', async () => {
    const loadTools = vi.fn()
    const out = await run({ query: '不存在的工具' }, ctx({ loadTools }))
    expect(out.total).toBe(0)
    expect(loadTools).toHaveBeenCalledWith([])
  })

  it('searchTools 缺失（未启用折叠）时如实报错，不假装搜过了', async () => {
    const out = await run({ query: 'file' }, { } as never)
    expect(String(out.error)).toContain('not enabled')
  })
})
