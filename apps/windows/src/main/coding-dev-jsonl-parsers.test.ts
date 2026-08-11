import { describe, it, expect } from 'vitest'
import { AcpToolStreamParser } from './coding-dev-jsonl-parsers.js'

describe('AcpToolStreamParser', () => {
  it('claude: 识别 tool_use 与 tool_result（真实 stream-json schema）', () => {
    const parser = new AcpToolStreamParser('claude')
    const toolUse = parser.parseLine(
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_01ABC","name":"bash","input":{"command":"ls"}}]}}',
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
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01ABC","content":"file1.txt\\nfile2.txt"}]}}',
    )
    expect(toolResult?.kind).toBe('tool')
    expect(toolResult?.tool?.phase).toBe('end')
    expect(toolResult?.tool?.result).toContain('file1.txt')
    // tool_result 不带工具名，须从前序 tool_use 回填，否则卡片标题渲染成 unknown
    expect(toolResult?.tool?.toolName).toBe('bash')
  })

  it('claude: 多个工具并行时 end 事件各自回填正确名字', () => {
    const parser = new AcpToolStreamParser('claude')
    parser.parseLine(
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"a.ts"}}]}}',
    )
    parser.parseLine(
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Grep","input":{"pattern":"foo"}}]}}',
    )
    const end2 = parser.parseLine(
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":"hit"}]}}',
    )
    const end1 = parser.parseLine(
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"src"}]}}',
    )
    expect(end2?.tool?.toolName).toBe('Grep')
    expect(end1?.tool?.toolName).toBe('Read')
  })

  it('claude: assistant 纯文本 content 转消息', () => {
    const parser = new AcpToolStreamParser('claude')
    const msg = parser.parseLine(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello world"}]}}',
    )
    expect(msg).toEqual({ kind: 'message', text: 'Hello world' })
  })

  it('claude: system/hook 事件被忽略，不产生进度事件', () => {
    const parser = new AcpToolStreamParser('claude')
    const hookStarted = parser.parseLine(
      '{"type":"system","subtype":"hook_started","hook_id":"7562c964-7395-4b7b-a5de-001a487bbfb7","hook_name":"SessionStart:startup","hook_event":"SessionStart","uuid":"e44262ab-5d10-490c-800c-7fb0554ac821","session_id":"dd2a3b11-a74f-4fdc-a1a1-6bd966c9c214"}',
    )
    expect(hookStarted).toBeNull()

    const hookResponse = parser.parseLine(
      '{"type":"system","subtype":"hook_response","hook_id":"7562c964-7395-4b7b-a5de-001a487bbfb7","hook_name":"SessionStart:startup","hook_event":"SessionStart","output":"PONYTAIL MODE ACTIVE"}',
    )
    expect(hookResponse).toBeNull()
  })

  it('claude: result 事件转为最终消息', () => {
    const parser = new AcpToolStreamParser('claude')
    const result = parser.parseLine('{"type":"result","subtype":"success","result":"任务完成"}')
    expect(result).toEqual({ kind: 'final_result', text: '任务完成' })
  })

  it('claude: 整段真实流不会把 JSONL 原文当消息漏出', () => {
    const parser = new AcpToolStreamParser('claude')
    const lines = [
      '{"type":"system","subtype":"init","session_id":"s1","tools":["Bash"]}',
      '{"type":"system","subtype":"hook_started","hook_name":"SessionStart:startup"}',
      '{"type":"system","subtype":"hook_response","hook_name":"SessionStart:startup","output":"PONYTAIL MODE ACTIVE"}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"WebSearch","input":{"query":"成都天气"}}]}}',
      '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"Web search results"}]}}',
      '{"type":"result","subtype":"success","result":"今天成都多云。"}',
    ]
    const out = lines.map((l) => parser.parseLine(l))
    // 任何 message 事件的文本都不该是 JSON 原文
    for (const ev of out) {
      if (ev?.kind === 'message') expect(ev.text.trimStart().startsWith('{')).toBe(false)
    }
    expect(out.filter((e) => e === null)).toHaveLength(3) // 3 条 system 全被忽略
    expect(out[3]?.tool?.toolName).toBe('WebSearch')
    expect(out[4]?.tool?.toolName).toBe('WebSearch') // end 回填
    expect(out[5]).toEqual({ kind: 'final_result', text: '今天成都多云。' })
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
