/**
 * FakeAgentKernel — 可预测的测试用 AgentKernel 实现
 *
 * 无需真实 pi-agent-core 即可跑 turn 流程的单测。
 * 支持：
 * - 注入固定响应文本
 * - 注入工具调用序列
 * - 注入错误
 * - 触发取消
 */

import type {
  AgentTurnRequest,
  AgentTurnEvent,
  AgentTurnResult,
  AgentKernelModelInfo,
} from "@mtbot/protocol";
import type { AgentKernel, UnsubscribeFn } from "./types.js";

export interface FakeTurnToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result: unknown;
  isError?: boolean;
}

export interface FakeKernelOptions {
  /** 固定回复文本（默认 "fake response"） */
  replyText?: string;
  /** 模型 ID（默认 "fake-model"） */
  modelId?: string;
  /** 每次 startTurn 注入的工具调用序列 */
  toolCalls?: FakeTurnToolCall[];
  /** 若设置，startTurn 将以此错误消息 reject */
  errorMessage?: string;
  /** 若为 true，startTurn 模拟被取消 */
  cancelled?: boolean;
  /** 模拟延迟（毫秒，默认 0） */
  delayMs?: number;
}

export class FakeAgentKernel implements AgentKernel {
  private readonly listeners = new Set<(event: AgentTurnEvent) => void>();
  private opts: FakeKernelOptions;
  /** 记录每次 startTurn 收到的 request，供测试断言 */
  readonly receivedRequests: AgentTurnRequest[] = [];

  constructor(opts: FakeKernelOptions = {}) {
    this.opts = opts;
  }

  /** 允许测试动态更新选项 */
  configure(opts: Partial<FakeKernelOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  async startTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
    this.receivedRequests.push(request);

    if (this.opts.delayMs && this.opts.delayMs > 0) {
      await new Promise<void>((r) => setTimeout(r, this.opts.delayMs));
    }

    if (request.signal?.aborted || this.opts.cancelled) {
      this.emit({ type: "turn:cancelled" });
      return { fullText: "", cancelled: true };
    }

    if (this.opts.errorMessage) {
      this.emit({ type: "turn:error", error: this.opts.errorMessage });
      return { fullText: "", cancelled: false, error: this.opts.errorMessage };
    }

    const replyText = this.opts.replyText ?? "fake response";

    this.emit({ type: "turn:start" });

    // 逐字符模拟 delta
    let accumulated = "";
    for (const ch of replyText) {
      accumulated += ch;
      this.emit({ type: "turn:delta", delta: ch, fullText: accumulated });
    }

    // 注入工具调用序列
    for (const tc of this.opts.toolCalls ?? []) {
      this.emit({
        type: "turn:tool_start",
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        args: tc.args,
      });
      this.emit({
        type: "turn:tool_end",
        toolCallId: tc.toolCallId,
        toolName: tc.toolName,
        result: tc.result,
        isError: tc.isError,
      });
    }

    this.emit({
      type: "turn:end",
      fullText: accumulated,
      usage: { inputTokens: 10, outputTokens: accumulated.length },
    });

    return { fullText: accumulated, cancelled: false };
  }

  cancelTurn(): void {
    this.opts = { ...this.opts, cancelled: true };
    this.emit({ type: "turn:cancelled" });
  }

  async listModels(): Promise<AgentKernelModelInfo[]> {
    return [{ id: this.opts.modelId ?? "fake-model", isDefault: true }];
  }

  getDefaultModel(): string {
    return this.opts.modelId ?? "fake-model";
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
        // 防止单个 listener 异常影响其他
      }
    }
  }
}
