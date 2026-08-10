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
      return { kind: 'message', text: obj.result }
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
  } catch (err) {
    /* 非 JSON */
    debugLog('codex', 'JSON 解析失败，回落文本', { error: err instanceof Error ? err.message : String(err), line: line.slice(0, 100) })
  }
  return { kind: 'message', text: line }
}

/**
 * Cursor Agent (stream-json): 与 claude 类似但细节不同（未实测，先占位）
 */
function parseCursorJsonLine(line: string): ParsedLine {
  try {
    const obj = JSON.parse(line)
    debugLog('cursor', '解析到 JSON 对象', { type: obj.type })

    // ponytail: 本机未装 cursor，schema 待实测后补全；暂时回落文本
    if (obj.type === 'tool_use') {
      debugLog('cursor', '识别到 tool_use', { id: obj.id, name: obj.name })
      return {
        kind: 'tool',
        tool: {
          toolCallId: obj.id ?? `tool-${Date.now()}`,
          toolName: obj.name ?? 'unknown',
          phase: 'start',
          args: obj.input,
        },
      }
    }
    if (obj.type === 'tool_result') {
      debugLog('cursor', '识别到 tool_result', { tool_use_id: obj.tool_use_id })
      return {
        kind: 'tool',
        tool: {
          toolCallId: obj.tool_use_id ?? `tool-${Date.now()}`,
          toolName: 'unknown',
          phase: 'end',
          result: obj.content,
          isError: obj.is_error === true,
        },
      }
    }
    if (obj.text) return { kind: 'message', text: obj.text }
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

/**
 * 工具流解析状态（逐行喂入，输出结构化事件）
 */
export class AcpToolStreamParser {
  private parser: ((line: string) => ParsedLine) | null

  constructor(backendId: LightweightCodingDevBackendId) {
    this.parser = PARSERS[backendId] ?? null
  }

  /**
   * 喂入一行 stdout，返回 0-1 条进度事件（工具调用或消息文本）
   */
  parseLine(line: string): CodingDevLightweightBackendProgress | null {
    const trimmed = line.trim()
    if (!trimmed) return null
    if (!this.parser) return { kind: 'message', text: line }

    const parsed = this.parser(trimmed)
    if (parsed.kind === 'tool') {
      return { kind: 'tool', text: '', tool: parsed.tool }
    }
    if (parsed.kind === 'message') {
      return { kind: 'message', text: parsed.text }
    }
    return null
  }
}
