/**
 * Agent Runtime 事件类型
 *
 * 将 pi-agent-core 的 AgentEvent 转换为客户端友好的事件格式，
 * 用于 IPC 传输到渲染进程更新 UI。
 */

import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";

import type { GatewayLlmErrorDetail } from "../llm/gateway-stream.js";

/** Agent 实例状态 */
export type AgentInstanceState = "idle" | "running" | "paused" | "error" | "aborted" | "destroyed";

/**
 * Agent Runtime 事件 — 通过 IPC 传输到渲染进程
 *
 * 比原始 AgentEvent 更扁平，适合序列化传输。
 */
export type AgentRuntimeEvent =
  | { type: "agent:start"; instanceId: string }
  | { type: "agent:end"; instanceId: string; loopInterrupted?: true }
  | {
      type: "agent:error";
      instanceId: string;
      error: string;
      /** 结构化错误（可选，与网关/流式层对齐） */
      code?: string;
      retryable?: boolean;
    }
  | { type: "agent:state-change"; instanceId: string; state: AgentInstanceState }
  | {
      type: "message:start";
      instanceId: string;
    }
  | {
      type: "message:delta";
      instanceId: string;
      /** 增量文本片段 */
      delta: string;
      /** 累积的完整文本（便于 UI 直接渲染） */
      fullText: string;
    }
  | {
      type: "message:thinking";
      instanceId: string;
      delta: string;
    }
  | {
      type: "message:end";
      instanceId: string;
      fullText: string;
      /** LLM 实际 token 使用量（来自 AssistantMessage.usage） */
      usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheRead?: number;
        cacheWrite?: number;
      };
      /**
       * 来自 pi-ai AssistantMessage.stopReason；toolUse 表示后续还有工具轮次，
       * 前端应保留同一条 assistant 气泡并维持 isStreaming，避免重复占位与「思考」条。
       */
      stopReason?: "end_turn" | "tool_use" | "max_tokens" | "error" | "aborted";
      /** 网关 HTTP / SSE 结构化错误（createGatewayStreamFn 挂载） */
      llmError?: GatewayLlmErrorDetail;
      /**
       * 本轮 Agent 运行注入到 system prompt 的热记忆（供 UI「基于您的偏好」提示）
       */
      injectedMemories?: readonly {
        readonly id: string;
        readonly content: string;
        readonly category: string;
      }[];
    }
  | {
      type: "tool:start";
      instanceId: string;
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool:update";
      instanceId: string;
      toolCallId: string;
      toolName: string;
      partialResult: unknown;
    }
  | {
      type: "tool:end";
      instanceId: string;
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    }
  | {
      type: "context:compaction";
      instanceId: string;
      tokensBefore: number;
      tokensAfter: number;
      threshold: number;
      messagesBefore: number;
      messagesAfter: number;
      usedSummary: boolean;
      strategy?: "micro" | "summary" | "hard-trim" | "none";
      /** PTL 重试次数（summary 策略，B2） */
      ptlRetries?: number;
      /** 是否为连续压缩链中的再压缩（B4 诊断） */
      isRecompaction?: boolean;
      /** 距上次压缩的轮次数（-1 表示首次，B4 诊断） */
      turnsSincePreviousCompact?: number;
      /** 断路器当前连续失败计数（B4 诊断） */
      consecutiveFailures?: number;
    };

/**
 * 将 pi-agent-core AgentEvent 转换为 AgentRuntimeEvent
 */
export function mapAgentEvent(
  instanceId: string,
  event: AgentEvent,
  accumulatedText: string,
): AgentRuntimeEvent | null {
  switch (event.type) {
    case "agent_start":
      return { type: "agent:start", instanceId };

    case "agent_end":
      return { type: "agent:end", instanceId };

    case "message_start":
      return { type: "message:start", instanceId };

    case "message_update": {
      const { assistantMessageEvent } = event;
      if (assistantMessageEvent.type === "text_delta") {
        return {
          type: "message:delta",
          instanceId,
          delta: assistantMessageEvent.delta,
          fullText: accumulatedText,
        };
      }
      if (assistantMessageEvent.type === "thinking_delta") {
        return {
          type: "message:thinking",
          instanceId,
          delta: assistantMessageEvent.delta,
        };
      }
      return null;
    }

    case "message_end": {
      // 从 AssistantMessage.usage 提取真实 token 数据
      // message_end 时 event.message 是 AssistantMessage，包含 usage 字段
      const assistantMsg = event.message as AssistantMessage | undefined;
      const usage = assistantMsg?.usage;
      const sr = assistantMsg?.stopReason;
      const llmErr = (assistantMsg as AssistantMessage & { __llmError?: GatewayLlmErrorDetail })
        ?.__llmError;
      /** pi-ai StopReason → 客户端统一 stopReason */
      let stopReason: "end_turn" | "tool_use" | "max_tokens" | "error" | "aborted" | undefined;
      if (sr === "toolUse") stopReason = "tool_use";
      else if (sr === "length") stopReason = "max_tokens";
      else if (sr === "error") stopReason = "error";
      else if (sr === "aborted") stopReason = "aborted";
      else stopReason = "end_turn";

      return {
        type: "message:end",
        instanceId,
        fullText: accumulatedText,
        stopReason,
        ...(llmErr ? { llmError: llmErr } : {}),
        ...(usage && {
          usage: {
            inputTokens: usage.input,
            outputTokens: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
          },
        }),
      };
    }

    case "tool_execution_start":
      return {
        type: "tool:start",
        instanceId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };

    case "tool_execution_update":
      return {
        type: "tool:update",
        instanceId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        partialResult: event.partialResult,
      };

    case "tool_execution_end":
      return {
        type: "tool:end",
        instanceId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      };

    case "turn_start":
    case "turn_end":
      return null;

    default:
      return null;
  }
}
