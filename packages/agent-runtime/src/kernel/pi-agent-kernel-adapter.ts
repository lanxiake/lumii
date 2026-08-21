/**
 * PiAgentKernelAdapter — 将 pi-agent-core Agent 适配为 AgentKernel 接口
 *
 * 这是 pi-agent-core 依赖的主要隔离层。
 * 业务层（AgentInstance 及上层）只看到 AgentKernel 接口，不直接依赖 pi-agent-core。
 */

import { type Agent } from "@mariozechner/pi-agent-core";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type {
  AgentTurnRequest,
  AgentTurnEvent,
  AgentTurnResult,
  AgentKernelModelInfo,
} from "./agent-turn-types.js";
import type { AgentKernel, UnsubscribeFn } from "./types.js";

export class PiAgentKernelAdapter implements AgentKernel {
  private readonly agent: Agent;
  private readonly listeners = new Set<(event: AgentTurnEvent) => void>();
  private accumulatedText = "";

  constructor(agent: Agent) {
    this.agent = agent;

    // 订阅 pi-agent-core 事件，转换并转发给 kernel listeners
    this.agent.subscribe((raw) => {
      this.handleRaw(raw);
    });
  }

  async startTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    this.accumulatedText = "";

    const images =
      request.images && request.images.length > 0
        ? request.images.map((img) => ({
            type: "image" as const,
            data: img.data,
            mimeType: img.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          }))
        : undefined;

    let finalResult: AgentTurnResult = {
      fullText: "",
      cancelled: false,
    };

    const done = new Promise<AgentTurnResult>((resolve) => {
      const unsub = this.agent.subscribe((raw) => {
        if (raw.type === "agent_end") {
          unsub();
          resolve({
            fullText: this.accumulatedText,
            cancelled: false,
          });
        }
        if (raw.type === "message_end") {
          const msg = raw.message as AssistantMessage | undefined;
          if (msg?.stopReason === "aborted") {
            unsub();
            resolve({
              fullText: this.accumulatedText,
              cancelled: true,
            });
          }
          if (msg?.stopReason === "error") {
            const errStr =
              typeof msg.errorMessage === "string"
                ? msg.errorMessage
                : JSON.stringify(msg.errorMessage);
            unsub();
            resolve({
              fullText: this.accumulatedText,
              cancelled: false,
              error: errStr,
            });
          }
        }
      });
    });

    try {
      await this.agent.prompt(request.message, images);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit({ type: "turn:error", error: msg });
      return { fullText: this.accumulatedText, cancelled: false, error: msg };
    }

    finalResult = await done;
    return finalResult;
  }

  cancelTurn(): void {
    this.agent.abort();
  }

  async listModels(): Promise<AgentKernelModelInfo[]> {
    const modelId = this.getDefaultModel();
    if (!modelId) return [];
    return [{ id: modelId, isDefault: true }];
  }

  getDefaultModel(): string {
    return (this.agent.state as { model?: { id?: string } }).model?.id ?? "";
  }

  subscribe(listener: (event: AgentTurnEvent) => void): UnsubscribeFn {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: AgentTurnEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        // 防止单个 listener 异常中断其他
      }
    }
  }

  private handleRaw(raw: AgentEvent): void {
    switch (raw.type) {
      case "agent_start":
        this.accumulatedText = "";
        this.emit({ type: "turn:start" });
        break;

      case "message_update": {
        const { assistantMessageEvent } = raw;
        if (assistantMessageEvent.type === "text_delta") {
          this.accumulatedText += assistantMessageEvent.delta;
          this.emit({
            type: "turn:delta",
            delta: assistantMessageEvent.delta,
            fullText: this.accumulatedText,
          });
        }
        if (assistantMessageEvent.type === "thinking_delta") {
          this.emit({ type: "turn:thinking", delta: assistantMessageEvent.delta });
        }
        break;
      }

      case "message_end": {
        const msg = raw.message as AssistantMessage | undefined;
        const usage = msg?.usage;
        this.emit({
          type: "turn:end",
          fullText: this.accumulatedText,
          ...(usage && {
            usage: {
              inputTokens: usage.input,
              outputTokens: usage.output,
              cacheRead: usage.cacheRead,
              cacheWrite: usage.cacheWrite,
            },
          }),
        });
        break;
      }

      case "tool_execution_start":
        this.emit({
          type: "turn:tool_start",
          toolCallId: raw.toolCallId,
          toolName: raw.toolName,
          args: raw.args,
        });
        break;

      case "tool_execution_end":
        this.emit({
          type: "turn:tool_end",
          toolCallId: raw.toolCallId,
          toolName: raw.toolName,
          result: raw.result,
          isError: raw.isError,
        });
        break;

      case "agent_end":
        // agent_end 由 startTurn 内部 done promise 处理，此处不再 emit
        break;

      default:
        break;
    }
  }
}
