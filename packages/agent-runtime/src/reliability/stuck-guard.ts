/**
 * StuckGuard — AgentInstance 的循环/卡死检测与处理（S9 R6-4）
 *
 * 从 AgentInstance 迁出工具调用循环检测、assistant 文本重复检测与冷却处理逻辑。
 * 检测纯函数（detectToolLoop / detectDuplicateAssistantContent）仍在
 * agent/stuck-detection.ts；本类持有循环检测的可变状态（工具指纹队列、警告轮次、
 * 打断标志），通过注入回调与 AgentInstance 协作执行 steer/followUp/abort。
 */

import { detectToolLoop, detectDuplicateAssistantContent } from "../agent/stuck-detection.js";

/** StuckGuard 所需的协作回调（由 AgentInstance 注入） */
export interface StuckGuardDeps {
  readonly instanceId: string;
  /** assistant 文本重复判定阈值（对齐 OpenManus duplicate_threshold） */
  readonly duplicateContentThreshold: number;
  /** 读取当前消息历史（用于 assistant 文本重复检测） */
  readonly getMessages: () => readonly unknown[];
  /** 读取当前 turn 计数 */
  readonly getTurnCount: () => number;
  /** 注入 steer 消息（给 LLM 最后一次机会） */
  readonly steer: (content: string) => void;
  /** 注入 followUp 消息（硬打断后引导收尾） */
  readonly followUp: (content: string) => void;
  /** 中止当前运行 */
  readonly abort: () => void;
}

const STEER_MESSAGE =
  "SYSTEM: You appear to be stuck in a loop, repeating the same actions or answers without making progress. " +
  "Please provide your best answer NOW based on the information gathered so far. " +
  "If you cannot complete the task, explain what you tried and why it did not work.";

const FOLLOWUP_MESSAGE =
  "SYSTEM: Tool execution loop detected and prevented. " +
  "The previous tool calls were blocked to avoid infinite loops. " +
  "Please provide your best answer based on information already gathered, or ask the user for clarification.";

const COOLDOWN_TURNS = 3;
const MAX_FINGERPRINTS = 24;
const ARGS_DIGEST_LENGTH = 80;

export class StuckGuard {
  private readonly deps: StuckGuardDeps;
  /** 最近工具调用指纹队列（循环检测用，保留最近 24 条，格式：toolName:argsDigest） */
  private recentToolNames: string[] = [];
  /** 发出 steer 警告时的 turnCount（-1 表示未发出） */
  private cycleWarnTurn = -1;
  /** 循环打断标志：agent:end 时注入到事件，通知 UI 展示提示 */
  private pendingLoopInterrupt = false;

  constructor(deps: StuckGuardDeps) {
    this.deps = deps;
  }

  /** agent_start 时调用：重置指纹队列与警告轮次 */
  reset(): void {
    this.recentToolNames = [];
    this.cycleWarnTurn = -1;
  }

  /** tool_execution_start 时调用：记录工具名+参数指纹（不做打断） */
  recordToolCall(toolName: string, args: unknown): void {
    // 参数摘要：JSON 序列化后取前 80 字符，区分同名工具的不同调用
    const argsDigest = args != null ? JSON.stringify(args).slice(0, ARGS_DIGEST_LENGTH) : "";
    this.recentToolNames.push(`${toolName}:${argsDigest}`);
    if (this.recentToolNames.length > MAX_FINGERPRINTS) this.recentToolNames.shift();
  }

  /** agent:end 时调用：读取并清除循环打断标志 */
  consumeLoopInterrupt(): boolean {
    if (!this.pendingLoopInterrupt) return false;
    this.pendingLoopInterrupt = false;
    return true;
  }

  /** turn_end 时调用：检测循环并按冷却策略处理 */
  checkAndHandle(): void {
    // 工具调用循环（指纹）或 assistant 文本内容重复（OpenManus is_stuck）任一命中即处理
    const loopDesc =
      detectToolLoop(this.recentToolNames) ??
      detectDuplicateAssistantContent(this.deps.getMessages(), {
        threshold: this.deps.duplicateContentThreshold,
      });
    if (!loopDesc) return;

    const turnCount = this.deps.getTurnCount();
    if (this.cycleWarnTurn < 0) {
      // 首次检测：注入 steer，给 LLM 最后一次机会
      this.cycleWarnTurn = turnCount;
      console.log(
        `[AgentInstance:${this.deps.instanceId}] 循环检测：${loopDesc}，注入 steer（turn=${turnCount}）`,
      );
      this.deps.steer(STEER_MESSAGE);
    } else if (turnCount - this.cycleWarnTurn >= COOLDOWN_TURNS) {
      // 冷却期后仍在循环：硬打断
      console.log(
        `[AgentInstance:${this.deps.instanceId}] 循环检测：${loopDesc} 持续超过 ${COOLDOWN_TURNS} 轮，中止并注入 followUp`,
      );
      this.cycleWarnTurn = -1;
      this.recentToolNames = [];
      this.pendingLoopInterrupt = true;
      this.deps.followUp(FOLLOWUP_MESSAGE);
      // agent_end 会自然流转状态，避免孤立 tool_call
      this.deps.abort();
    }
  }
}
