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

/**
 * Claude Code (stream-json --verbose): JSONL 中 type:"message" 下 content[] 包含 tool_use/tool_result
 */
function parseClaudeJsonLine(line: string): ParsedLine {
  try {
    const obj = JSON.parse(line)
    if (obj.type === 'message' && Array.isArray(obj.content)) {
      for (const item of obj.content) {
        if (item.type === 'tool_use') {
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
      }
    }
    if (obj.type === 'text' && obj.text) {
      return { kind: 'message', text: obj.text }
    }
  } catch {
    /* 非 JSON 或结构不匹配，回落普通文本 */
  }
  return { kind: 'message', text: line }
}

/**
 * Codex (--json): JSONL 中 type:item.started/item.completed, item.type:command_execution
 */
function parseCodexJsonLine(line: string): ParsedLine {
  try {
    const obj = JSON.parse(line)
    if (obj.type === 'item.started' && obj.item?.type === 'command_execution') {
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
  } catch {
    /* 非 JSON */
  }
  return { kind: 'message', text: line }
}

/**
 * Cursor Agent (stream-json): 与 claude 类似但细节不同（未实测，先占位）
 */
function parseCursorJsonLine(line: string): ParsedLine {
  try {
    const obj = JSON.parse(line)
    // ponytail: 本机未装 cursor，schema 待实测后补全；暂时回落文本
    if (obj.type === 'tool_use') {
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
  } catch {
    /* 非 JSON */
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
  // 其余后端暂无解析器，回落纯文本
  qoder: null,
  qwen: null,
  kimi: null,
  opencode: null,
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
