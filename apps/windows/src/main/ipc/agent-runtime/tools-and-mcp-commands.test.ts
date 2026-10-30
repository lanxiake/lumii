import { beforeEach, describe, expect, it, vi } from 'vitest'

const styleMock = vi.hoisted(() => vi.fn(async () => ({ style: 'detailed' as string })))

vi.mock('../../tool-usage-store', () => ({
  getToolUsage: vi.fn(async () => ({})),
  getToolUsageByAgent: vi.fn(async () => ({})),
  UNKNOWN_AGENT_ID: 'unknown',
}))
vi.mock('../../agent-runtime/prompt-style-accessor', () => ({
  getPromptStyleSettings: styleMock,
}))

const { handleCapabilityInventory } = await import('./tools-and-mcp-commands')
const { estimateToolTokens } = await import('../../agent-runtime/context-usage-breakdown')
const { stripToolDefinition } = await import('@mtbot/agent-runtime')

const schema = {
  type: 'object',
  properties: { path: { type: 'string', description: '要读的绝对路径' } },
  required: ['path'],
}
// 简单工具：minimal 档会被裁剪；复杂工具：在 COMPLEX_TOOL_NAMES 里，原样保留
const readTool = { name: 'file_read', description: '读取文件内容。', parameters: schema }
const bashTool = { name: 'bash', description: '执行 shell 命令。', parameters: schema }

const bridge = {
  getCapabilityInventorySource: async () => ({ tools: [readTool, bashTool], skills: [] }),
} as never

const rowsOf = async () =>
  (await handleCapabilityInventory(bridge)) as { id: string; residentTokens: number }[]

describe('handleCapabilityInventory', () => {
  beforeEach(() => {
    styleMock.mockResolvedValue({ style: 'detailed' })
  })

  it('detailed 档原样计价', async () => {
    const rows = await rowsOf()
    for (const tool of [readTool, bashTool]) {
      expect(rows.find((r) => r.id === tool.name)!.residentTokens).toBe(estimateToolTokens(tool))
    }
  })

  it('minimal 档按**裁剪后**的定义计价：简单工具变便宜，复杂工具不变', async () => {
    styleMock.mockResolvedValue({ style: 'minimal' })
    const rows = await rowsOf()
    const read = rows.find((r) => r.id === 'file_read')!.residentTokens
    const bash = rows.find((r) => r.id === 'bash')!.residentTokens

    // 逐条对上裁剪后的定义——这正是 tool_exposure_log 记的那一份
    expect(read).toBe(estimateToolTokens(stripToolDefinition(readTool)))
    expect(bash).toBe(estimateToolTokens(bashTool))
    expect(read).toBeLessThan(bash)
  })
})
