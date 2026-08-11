/**
 * 各 ACP 后端的 JSONL 流解析器：从原始 stdout 识别工具调用事件
 *
 * 每个后端的 JSON schema 都不同，这里统一转换为 CodingDevToolProgress。
 * ponytail: 3 个小解析器，各自 schema 硬编码而非抽象工厂 — 只写需要的。
 */

import type {
  CodingDevToolProgress,
  CodingDevLightweightBackendProgress,
  LightweightCodingDevBackendId,
} from './coding-dev-backends-stub/contracts.js'

type ParsedLine =
  | { kind: 'tool'; tool: CodingDevToolProgress }
  | { kind: 'message'; text: string }
  | { kind: 'ignore' }
  | { kind: 'final_result'; text: string }

// 调试日志开关（可通过环境变量 DEBUG_ACP_PARSER=1 启用）
const DEBUG = process.env.DEBUG_ACP_PARSER === '1'

function debugLog(backendId: string, message: string, data?: unknown): void {
  if (DEBUG) {
    console.log(`[ACP-Parser:${backendId}]`, message, data !== undefined ? data : '')
  }
}

/**
 * Claude Code (--output-format stream-json --verbose) 真实 JSONL schema：
 *
 *   {"type":"system","subtype":"init"|"hook_started"|"hook_response",...}     — 系统/hook 事件，忽略
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}|{"type":"tool_use","id":"...","name":"...","input":{...}}]}}
 *   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"...","content":"...","is_error":bool}]}}
 *   {"type":"result","subtype":"success"|"error","result":"...",...}         — 最终结果
 *
 * 注：早期实现假设顶层 type:"message"，与实际输出不符，导致工具调用从未被识别过。
 */
function parseClaudeJsonLine(line: string): ParsedLine {
  try {
    const obj = JSON.parse(line)
    debugLog('claude', '解析到 JSON 对象', { type: obj.type, subtype: obj.subtype })

    if (obj.type === 'system') {
      // hook_started/hook_response/init 等系统事件，不作为消息展示，避免刷屏
      return { kind: 'ignore' }
    }

    if ((obj.type === 'assistant' || obj.type === 'user') && Array.isArray(obj.message?.content)) {
      for (const item of obj.message.content) {
        if (item.type === 'tool_use') {
          debugLog('claude', '识别到 tool_use', { id: item.id, name: item.name })
          return {
            kind: 'tool',
            tool: {
              toolCallId: item.id ?? `tool-${Date.now()}`,
              toolName: item.name ?? 'unknown',
              phase: 'start',
              args: item.input,
            },
          }
        }
        if (item.type === 'tool_result') {
          debugLog('claude', '识别到 tool_result', { tool_use_id: item.tool_use_id })
          return {
            kind: 'tool',
            tool: {
              toolCallId: item.tool_use_id ?? `tool-${Date.now()}`,
              toolName: 'unknown',
              phase: 'end',
              result: item.content,
              isError: item.is_error === true,
            },
          }
        }
        if (item.type === 'text' && item.text) {
          return { kind: 'message', text: item.text }
        }
      }
    }

    if (obj.type === 'result' && typeof obj.result === 'string') {
      debugLog('claude', '识别到最终结果', { result: obj.result.slice(0, 100) })
      return { kind: 'final_result', text: obj.result }
    }
  } catch (err) {
    /* 非 JSON 或结构不匹配，回落普通文本 */
    debugLog('claude', 'JSON 解析失败，回落文本', { error: err instanceof Error ? err.message : String(err), line: line.slice(0, 100) })
    return { kind: 'message', text: line }
  }
  return { kind: 'ignore' }
}

/**
 * Codex (--json): JSONL 中 type:item.started/item.completed, item.type:command_execution
 *
 * 最终结果：最后一个 item.completed 的 aggregated_output（若无工具调用则整体输出作为结果）
 */
function parseCodexJsonLine(line: string): ParsedLine {
  try {
    const obj = JSON.parse(line)
    debugLog('codex', '解析到 JSON 对象', { type: obj.type })

    if (obj.type === 'item.started' && obj.item?.type === 'command_execution') {
      debugLog('codex', '识别到 command_execution started', { id: obj.item.id })
      return {
        kind: 'tool',
        tool: {
          toolCallId: obj.item.id ?? `cmd-${Date.now()}`,
          toolName: 'bash',
          phase: 'start',
          args: { command: obj.item.command },
        },
      }
    }
    if (obj.type === 'item.completed' && obj.item?.type === 'command_execution') {
      debugLog('codex', '识别到 command_execution completed', { id: obj.item.id, exit_code: obj.item.exit_code })
      return {
        kind: 'tool',
        tool: {
          toolCallId: obj.item.id ?? `cmd-${Date.now()}`,
          toolName: 'bash',
          phase: 'end',
          result: obj.item.aggregated_output,
          isError: obj.item.exit_code !== 0,
        },
      }
    }
    // codex 可能输出 type:"message" 或其他文本事件
    if (obj.type === 'message' && obj.text) {
      return { kind: 'message', text: obj.text }
    }
    // 如果是最后的总结输出（无明确 type 标记），作为 final_result
    if (obj.output && typeof obj.output === 'string') {
      debugLog('codex', '识别到最终输出', { output: obj.output.slice(0, 100) })
      return { kind: 'final_result', text: obj.output }
    }
  } catch (err) {
    /* 非 JSON */
    debugLog('codex', 'JSON 解析失败，回落文本', { error: err instanceof Error ? err.message : String(err), line: line.slice(0, 100) })
  }
  return { kind: 'message', text: line }
}

/**
 * Cursor Agent (stream-json): 与 claude 类似但细节不同（未实测，先占位）
 *
 * 假设与 Claude 结构相近，最终结果可能在 type:"result" 或 type:"response" 中
 */
function parseCursorJsonLine(line: string): ParsedLine {
  try {
    const obj = JSON.parse(line)
    debugLog('cursor', '解析到 JSON 对象', { type: obj.type })

    // 尝试与 Claude 相同的 assistant/user message 结构
    if ((obj.type === 'assistant' || obj.type === 'user') && Array.isArray(obj.message?.content)) {
      for (const item of obj.message.content) {
        if (item.type === 'tool_use') {
          debugLog('cursor', '识别到 tool_use', { id: item.id, name: item.name })
          return {
            kind: 'tool',
            tool: {
              toolCallId: item.id ?? `tool-${Date.now()}`,
              toolName: item.name ?? 'unknown',
              phase: 'start',
              args: item.input,
            },
          }
        }
        if (item.type === 'tool_result') {
          debugLog('cursor', '识别到 tool_result', { tool_use_id: item.tool_use_id })
          return {
            kind: 'tool',
            tool: {
              toolCallId: item.tool_use_id ?? `tool-${Date.now()}`,
              toolName: 'unknown',
              phase: 'end',
              result: item.content,
              isError: item.is_error === true,
            },
          }
        }
        if (item.type === 'text' && item.text) {
          return { kind: 'message', text: item.text }
        }
      }
    }

    // 最终结果（猜测可能是 type:"result" 或 type:"response"）
    if ((obj.type === 'result' || obj.type === 'response') && typeof obj.result === 'string') {
      debugLog('cursor', '识别到最终结果', { result: obj.result.slice(0, 100) })
      return { kind: 'final_result', text: obj.result }
    }
    if ((obj.type === 'result' || obj.type === 'response') && typeof obj.text === 'string') {
      debugLog('cursor', '识别到最终结果', { text: obj.text.slice(0, 100) })
      return { kind: 'final_result', text: obj.text }
    }
  } catch (err) {
    /* 非 JSON */
    debugLog('cursor', 'JSON 解析失败，回落文本', { error: err instanceof Error ? err.message : String(err), line: line.slice(0, 100) })
  }
  return { kind: 'message', text: line }
}

/**
 * OpenCode (run): 输出格式待确认，先尝试通用 JSONL 解析
 */
function parseOpenCodeJsonLine(line: string): ParsedLine {
  try {
    const obj = JSON.parse(line)
    debugLog('opencode', '解析到 JSON 对象', obj)

    // 尝试通用的工具调用格式
    if (obj.type === 'tool_call' || obj.type === 'tool_use') {
      debugLog('opencode', '识别到工具调用', { id: obj.id, name: obj.name })
      return {
        kind: 'tool',
        tool: {
          toolCallId: obj.id ?? `tool-${Date.now()}`,
          toolName: obj.name ?? obj.tool_name ?? 'unknown',
          phase: 'start',
          args: obj.args ?? obj.input ?? obj.parameters,
        },
      }
    }
    if (obj.type === 'tool_result' || obj.type === 'tool_output') {
      debugLog('opencode', '识别到工具结果', { id: obj.id })
      return {
        kind: 'tool',
        tool: {
          toolCallId: obj.id ?? obj.call_id ?? `tool-${Date.now()}`,
          toolName: 'unknown',
          phase: 'end',
          result: obj.result ?? obj.output ?? obj.content,
          isError: obj.is_error === true || obj.error === true,
        },
      }
    }
    // 通用消息格式
    if (obj.message || obj.text || obj.content) {
      return { kind: 'message', text: obj.message ?? obj.text ?? obj.content }
    }
  } catch (err) {
    debugLog('opencode', 'JSON 解析失败，回落文本', { error: err instanceof Error ? err.message : String(err), line: line.slice(0, 100) })
  }
  return { kind: 'message', text: line }
}

const PARSERS: Record<
  LightweightCodingDevBackendId,
  ((line: string) => ParsedLine) | null
> = {
  claude: parseClaudeJsonLine,
  codex: parseCodexJsonLine,
  cursor: parseCursorJsonLine,
  opencode: parseOpenCodeJsonLine,
  // 其余后端暂无解析器，回落纯文本
  qoder: null,
  qwen: null,
  kimi: null,
  copilot: null,
  auggie: null,
  gemini: null,
  hermes: null,
}

/** parseLine 的返回类型：在通用进度事件之外，额外区分「最终结果」与「静默忽略」 */
export type AcpParsedProgress =
  | CodingDevLightweightBackendProgress
  | { kind: 'final_result'; text: string; tool?: undefined }

/**
 * 工具流解析状态（逐行喂入，输出结构化事件）
 */
export class AcpToolStreamParser {
  private parser: ((line: string) => ParsedLine) | null

  /** 该后端是否有 JSONL 解析器。有解析器意味着 stdout 是 JSONL，不可直接展示给用户 */
  get hasParser(): boolean {
    return this.parser !== null
  }
  /**
   * toolCallId → toolName。多数 CLI 的结束事件只带 id 不带名字（如 claude 的
   * tool_result 只有 tool_use_id），而下游 tool_end 会用事件里的 name 覆盖卡片标题，
   * 名字缺失就会渲染成 unknown。这里在 start 时记下，end 时回填。
   */
  private toolNames = new Map<string, string>()

  constructor(backendId: LightweightCodingDevBackendId) {
    this.parser = PARSERS[backendId] ?? null
  }

  /**
   * 喂入一行 stdout，返回 0-1 条进度事件（工具调用、消息文本或最终结果）
   */
  parseLine(line: string): AcpParsedProgress | null {
    const trimmed = line.trim()
    if (!trimmed) return null
    if (!this.parser) return { kind: 'message', text: line }

    const parsed = this.parser(trimmed)
    if (parsed.kind === 'tool') {
      const tool = this.withResolvedToolName(parsed.tool)
      return { kind: 'tool', text: '', tool }
    }
    if (parsed.kind === 'message') {
      return { kind: 'message', text: parsed.text }
    }
    if (parsed.kind === 'final_result') {
      return { kind: 'final_result', text: parsed.text }
    }
    return null
  }

  /**
   * start 阶段记下工具名；end 阶段名字缺失时用记下的名字回填
   */
  private withResolvedToolName(tool: CodingDevToolProgress): CodingDevToolProgress {
    if (tool.phase === 'start') {
      if (tool.toolName && tool.toolName !== 'unknown') {
        this.toolNames.set(tool.toolCallId, tool.toolName)
      }
      return tool
    }
    const known = this.toolNames.get(tool.toolCallId)
    if (tool.phase === 'end') this.toolNames.delete(tool.toolCallId)
    if (!known || (tool.toolName && tool.toolName !== 'unknown')) return tool
    return { ...tool, toolName: known }
  }
}
