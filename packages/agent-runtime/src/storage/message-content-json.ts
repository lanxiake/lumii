/**
 * content_json 解析 — 纯函数，无 Node 依赖（可供 renderer 安全引用）
 */

import type { AssistantPartsContent } from "./assistant-parts.js";

/** 工具调用记录（嵌入 assistant 消息） */
export interface ToolCallRecord {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly result?: unknown;
  readonly isError?: boolean;
  /** 工具调用开始时，消息文本的字符长度。用于渲染时将工具卡片插入文字正确位置。 */
  readonly textPositionAtStart?: number;
}

/** assistant 文本消息 */
export interface TextMessageContent {
  readonly type: "text";
  readonly text: string;
  /** 推理内容（DeepSeek / extended thinking 模型的思考过程，已从正文剥离） */
  readonly thinkingText?: string;
  readonly toolCalls?: readonly ToolCallRecord[];
  /** 最后一轮 message:end 的 token 用量（可选，落库于整轮结束） */
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheRead?: number;
    readonly cacheWrite?: number;
  };
  /** 子 Agent 来源信息（仅子 Agent 消息有此字段，用于重启后恢复 label） */
  readonly sourceAgent?: {
    readonly instanceId: string;
    readonly label: string;
  };
  /** 用户语音消息：标识 + 原始录音 WAV base64（仅本地 UI 回放，不送 LLM） */
  readonly isVoice?: boolean;
  readonly audioWavBase64?: string;
}

/** tool_result 消息（工具执行结果） */
export interface ToolResultContent {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly tool_name: string;
  readonly result: unknown;
  readonly is_error: boolean;
}

/** content_json 联合类型 — 覆盖 messages 表中所有合法 JSON 结构 */
export type MessageContentJson = AssistantPartsContent | TextMessageContent | ToolResultContent;

/**
 * 将数据库存储的 content_json 字符串解析为强类型结构。
 * 解析失败或未知结构时返回 undefined。
 */
export function parseMessageContentJson(raw: string): MessageContentJson | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const o = parsed as Record<string, unknown>;
    if (o.type === "text") {
      const text = typeof o.text === "string" ? o.text : "";
      const thinkingText = typeof o.thinkingText === "string" ? o.thinkingText : undefined;
      const toolCalls = o.toolCalls;
      const usage = o.usage;
      const sa = o.sourceAgent;
      const sourceAgent =
        sa &&
        typeof sa === "object" &&
        typeof (sa as Record<string, unknown>).instanceId === "string"
          ? {
              instanceId: (sa as Record<string, unknown>).instanceId as string,
              label: String((sa as Record<string, unknown>).label ?? ""),
            }
          : undefined;
      const isVoice = o.isVoice === true ? true : undefined;
      const audioWavBase64 =
        typeof o.audioWavBase64 === "string" && o.audioWavBase64.length > 0
          ? o.audioWavBase64
          : undefined;
      return {
        type: "text",
        text,
        ...(thinkingText ? { thinkingText } : {}),
        ...(Array.isArray(toolCalls) ? { toolCalls } : {}),
        ...(usage && typeof usage === "object"
          ? { usage: usage as TextMessageContent["usage"] }
          : {}),
        ...(sourceAgent ? { sourceAgent } : {}),
        ...(isVoice ? { isVoice: true } : {}),
        ...(audioWavBase64 ? { audioWavBase64 } : {}),
      } as TextMessageContent;
    }
    if (o.type === "assistant_parts" && Array.isArray(o.parts)) {
      return parsed as AssistantPartsContent;
    }
    if (o.type === "tool_result") {
      return parsed as ToolResultContent;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * 从 content_json 里取出「人看得见的对话正文」。
 *
 * 为什么需要它：落库格式有两种——助手消息是 `assistant_parts`（parts 为唯一真相），
 * 用户消息与旧数据是扁平 `text`。只判 `type === "text"` 会把**助手说过的话全部漏掉**，
 * 于是「段原文归档」与「段落总结」拿到的是一份只有用户发言的对话
 * （2026-09-17 实测：多轮段的 5 条消息里有 2 条被静默丢弃）。
 *
 * thinking 与 tool part 不参与：前者是推理过程，后者是结构化结果，都不是对话正文。
 */
export function extractMessageText(raw: string, separator = "\n"): string {
  const parsed = parseMessageContentJson(raw);
  if (!parsed) return "";
  if (parsed.type === "text") return (parsed.text ?? "").trim();
  if (parsed.type === "assistant_parts") {
    return parsed.parts
      .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
      .map((p) => p.text.trim())
      .filter(Boolean)
      .join(separator)
      .trim();
  }
  return "";
}
