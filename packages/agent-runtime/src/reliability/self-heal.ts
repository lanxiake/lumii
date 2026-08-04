/**
 * SelfHealController — AgentInstance 的自愈层（Self-Healing）
 *
 * 从 AgentInstance 迁出可恢复 LLM 错误的检测与重试逻辑（S9 R6-3）。
 * 错误分类与消息修复底层实现仍在 reliability/message-repair.ts；本控制器只负责
 * "检测错误类型 → 选择修复策略 → 调 continue() 重试"的接线，通过注入回调与
 * AgentInstance 协作，避免直接耦合 pi-agent-core。
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { classifyLlmError, repairMessageSequence } from "./message-repair.js";
import { pruneThinkingForDeepSeek } from "../agent/message-pruner.js";

/** 自愈控制器所需的协作回调（由 AgentInstance 注入） */
export interface SelfHealDeps {
  readonly instanceId: string;
  readonly maxRetries: number;
  readonly cooldownMs: number;
  /** 读取当前消息历史 */
  readonly getMessages: () => readonly AgentMessage[];
  /** 替换消息历史 */
  readonly replaceMessages: (messages: AgentMessage[]) => void;
  /** 追加消息 */
  readonly appendMessage: (message: AgentMessage) => void;
  /** 触发 agent.continue() 重试 */
  readonly continueAgent: () => Promise<void>;
  /** 实例是否已销毁（延迟重试前检查） */
  readonly isDestroyed: () => boolean;
  /** 是否正在结束以进入 paused（此时不自愈） */
  readonly isEndingPause: () => boolean;
  /** 自愈彻底失败时回调（AgentInstance 据此置 error 状态并 emit） */
  readonly onError: (error: string) => void;
  /** 自愈链结束（成功重试发起或失败）时通知 prompt() resolve */
  readonly onSettled: () => void;
}

export class SelfHealController {
  private readonly deps: SelfHealDeps;
  private attempts = 0;
  private healing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: SelfHealDeps) {
    this.deps = deps;
  }

  /** 是否正在自愈重试中（AgentInstance 据此抑制 agent:end 与状态转换） */
  get isHealing(): boolean {
    return this.healing;
  }

  /** 每次新的 prompt 开始时重置重试计数 */
  reset(): void {
    this.attempts = 0;
  }

  /** 清理延迟重试定时器（destroy 时调用） */
  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * 检测最后一条消息的错误类型，尝试修复消息序列并重试。
   * 返回 true 表示正在自愈（调用方应跳过正常的 agent:end 处理），false 表示不可自愈。
   */
  attemptSelfHeal(): boolean {
    if (this.attempts >= this.deps.maxRetries) return false;
    if (this.deps.isEndingPause()) return false;

    const messages = this.deps.getMessages();
    const lastMsg = messages.at(-1) as
      | { role?: string; stopReason?: string; errorMessage?: unknown }
      | undefined;
    if (!lastMsg || lastMsg.stopReason !== "error") return false;

    const errorText =
      typeof lastMsg.errorMessage === "string"
        ? lastMsg.errorMessage
        : JSON.stringify(lastMsg.errorMessage ?? "");
    const category = classifyLlmError(errorText);

    if (category === "unrecoverable") return false;

    this.attempts++;
    console.log(
      `[AgentInstance:${this.deps.instanceId}] 自愈层: 检测到 ${category} 错误 (attempt ${this.attempts}/${this.deps.maxRetries})`,
      `error="${errorText.slice(0, 200)}"`,
    );

    if (category === "tool_pairing") {
      this.healToolPairing();
    } else if (category === "prompt_too_long") {
      this.healPromptTooLong();
    } else if (category === "thinking_required") {
      this.healThinkingRequired();
    } else {
      // rate_limit / server_error: 延迟后直接重试
      this.healDelayedRetry();
    }

    return true;
  }

  /** 修复 tool/toolResult 配对问题后重试 */
  private healToolPairing(): void {
    const original = this.deps.getMessages();
    const repaired = repairMessageSequence(original as AgentMessage[]);
    this.deps.replaceMessages(repaired);
    console.log(
      `[AgentInstance:${this.deps.instanceId}] 自愈层: 消息序列修复完成`,
      `before=${original.length}`,
      `after=${repaired.length}`,
    );
    this.continueRetry();
  }

  /** 截断旧消息降低 token 数后重试 */
  private healPromptTooLong(): void {
    const messages = this.deps.getMessages();
    // 移除尾部错误 assistant，然后丢弃前 1/3 的消息（保留最近 2/3）
    const withoutError = messages.filter((m) => {
      const msg = m as { role?: string; stopReason?: string };
      return !(msg.role === "assistant" && msg.stopReason === "error");
    });
    const keepCount = Math.max(4, Math.ceil((withoutError.length * 2) / 3));
    const truncated = withoutError.slice(-keepCount);
    // 再清理可能产生的孤立 toolResult
    const cleaned = repairMessageSequence(truncated as AgentMessage[]);
    this.deps.replaceMessages(cleaned);
    console.log(
      `[AgentInstance:${this.deps.instanceId}] 自愈层: prompt_too_long 截断`,
      `before=${messages.length} after=${cleaned.length}`,
    );
    this.continueRetry();
  }

  /** 延迟后重试（适用于 rate_limit / server_error） */
  private healDelayedRetry(): void {
    const messages = this.deps.getMessages();
    const cleaned = messages.filter((m) => {
      const msg = m as { role?: string; stopReason?: string };
      return !(msg.role === "assistant" && msg.stopReason === "error");
    });
    this.deps.replaceMessages(cleaned as AgentMessage[]);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.deps.isDestroyed()) return;
      this.continueRetry();
    }, this.deps.cooldownMs);
  }

  /** 修复 DeepSeek thinking_required 错误（设计 §6.5：分级剥离，替代一次性全量剥离）：
   *
   * 不一致根因：历史中部分 assistant 有 thinkingText（带 reasoning_content），部分没有
   * （旧数据 / 思考模式开启前的遗留），DeepSeek 要求同一请求内 reasoning 一致。
   *
   * 分级策略（attempt 递增逐步加重，避免一上来就丢光推理链放大幻觉）：
   * - 第 1 次：aggressive prune —— 仅剥离「历史已闭合轮」的 thinking，保留当前未闭合 user 轮的
   *   推理链（当前轮的 reasoning 通常完整、且对续写最关键）。多数 400 来自历史轮不一致，
   *   此步即可修复且保住当前轮推理。
   * - 第 2 次及以后：全量剥离 —— 兜底，剥除所有 assistant 的 thinking，使历史对 DeepSeek
   *   呈现为「无思考」一致态。
   */
  private healThinkingRequired(): void {
    const messages = this.deps.getMessages();

    // 第一步：删除错误的 assistant 消息
    const withoutError = messages.filter((m) => {
      const msg = m as { role?: string; stopReason?: string };
      return !(msg.role === "assistant" && msg.stopReason === "error");
    }) as AgentMessage[];

    // 第二步：按 attempt 分级剥离 thinking
    const isFirstAttempt = this.attempts <= 1;
    let cleaned: AgentMessage[];
    if (isFirstAttempt) {
      // aggressive：仅剥离历史已闭合轮的 thinking，保留当前未闭合 user 轮
      cleaned = pruneThinkingForDeepSeek(withoutError, "aggressive");
    } else {
      // 兜底：全量剥离所有 assistant 的 thinking
      cleaned = withoutError.map((m) => {
        const msg = m as { role?: string; content?: unknown };
        if (msg.role !== "assistant" || !Array.isArray(msg.content)) return m;
        const hasThinking = msg.content.some((b) => (b as { type?: string }).type === "thinking");
        if (!hasThinking) return m;
        const filteredContent = msg.content.filter(
          (b) => (b as { type?: string }).type !== "thinking",
        );
        return { ...msg, content: filteredContent } as AgentMessage;
      });
    }

    // 第三步：移除剥离后内容为空的 assistant 消息（原本只有 thinking block 的消息）
    const finalMessages = cleaned.filter((m) => {
      const msg = m as { role?: string; content?: unknown };
      if (msg.role !== "assistant") return true;
      if (!Array.isArray(msg.content)) return true;
      return msg.content.some((b) => {
        const block = b as { type?: string };
        return block.type === "text" || block.type === "toolCall";
      });
    });

    this.deps.replaceMessages(finalMessages as AgentMessage[]);
    console.log(
      `[AgentInstance:${this.deps.instanceId}] 自愈层: thinking_required 修复完成 ` +
        `(${isFirstAttempt ? "分级剥离-仅历史轮" : "全量剥离-兜底"})`,
      `before=${messages.length} after=${finalMessages.length}`,
    );
    this.continueRetry();
  }

  /** 执行自愈重试：确保最后消息合法后调用 continue() */
  private continueRetry(): void {
    this.healing = true;
    const messages = this.deps.getMessages();
    const lastMsg = messages.at(-1) as { role?: string } | undefined;

    // continue() 要求最后一条不是 assistant；如果是，注入恢复 user 消息
    if (lastMsg?.role === "assistant") {
      this.deps.appendMessage({
        role: "user",
        content: "Please continue with the task. The previous response encountered an error.",
        timestamp: Date.now(),
      } as AgentMessage);
    }

    void this.deps
      .continueAgent()
      .catch((err) => {
        console.error(`[AgentInstance:${this.deps.instanceId}] 自愈重试失败:`, err);
        this.healing = false;
        this.deps.onError(
          `Self-heal retry failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        // 自愈失败时也要通知 settle，避免 prompt() 永远挂起
        this.deps.onSettled();
      })
      .finally(() => {
        this.healing = false;
      });
  }
}
