import { describe, it, expect } from 'vitest'
import { AcpToolStreamParser } from './coding-dev-jsonl-parsers.js'

describe('AcpToolStreamParser', () => {
  it('claude: 识别 tool_use 与 tool_result', () => {
    const parser = new AcpToolStreamParser('claude')
    const toolUse = parser.parseLine(
      '{"type":"message","content":[{"type":"tool_use","id":"toolu_01ABC","name":"bash","input":{"command":"ls"}}]}',
    )
    expect(toolUse).toEqual({
      kind: 'tool',
      text: '',
      tool: {
        toolCallId: 'toolu_01ABC',
        toolName: 'bash',
        phase: 'start',
        args: { command: 'ls' },
      },
    })

    const toolResult = parser.parseLine(
      '{"type":"message","content":[{"type":"tool_result","tool_use_id":"toolu_01ABC","content":"file1.txt\\nfile2.txt"}]}',
    )
    expect(toolResult?.kind).toBe('tool')
    expect(toolResult?.tool?.phase).toBe('end')
    expect(toolResult?.tool?.result).toContain('file1.txt')
  })

  it('claude: 纯文本 content 转消息', () => {
    const parser = new AcpToolStreamParser('claude')
    const msg = parser.parseLine('{"type":"text","text":"Hello world"}')
    expect(msg).toEqual({ kind: 'message', text: 'Hello world' })
  })

  it('codex: 识别 command_execution 开始与结束', () => {
    const parser = new AcpToolStreamParser('codex')
    const start = parser.parseLine(
      '{"type":"item.started","item":{"id":"cmd123","type":"command_execution","command":"git status"}}',
    )
    expect(start?.kind).toBe('tool')
    expect(start?.tool?.phase).toBe('start')
    expect(start?.tool?.toolName).toBe('bash')
    expect(start?.tool?.args).toEqual({ command: 'git status' })

    const end = parser.parseLine(
      '{"type":"item.completed","item":{"id":"cmd123","type":"command_execution","exit_code":0,"aggregated_output":"On branch main"}}',
    )
    expect(end?.kind).toBe('tool')
    expect(end?.tool?.phase).toBe('end')
    expect(end?.tool?.isError).toBe(false)
  })

  it('无解析器后端回落为纯文本', () => {
    const parser = new AcpToolStreamParser('qwen')
    const msg = parser.parseLine('some random output')
    expect(msg).toEqual({ kind: 'message', text: 'some random output' })
  })

  it('空行返回 null', () => {
    const parser = new AcpToolStreamParser('claude')
    expect(parser.parseLine('')).toBeNull()
    expect(parser.parseLine('   ')).toBeNull()
  })
})
