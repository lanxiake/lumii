/**
 * compact 子系统 —— 类型与常量中心
 *
 * 集中全部对外类型与默认常量，消除原 context-compactor.ts 中散落的定义。
 * 字段与原实现完全一致，确保 agent-instance 接线零改动（仅改 import 路径）。
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { PostCompactRebuild } from "./post-compact.js";

// ==================== 默认常量 ====================

/**
 * 上下文压缩的默认触发比例（相对模型「真实」上下文窗口）。
 *
 * 触发点 = contextWindow × triggerRatio。三处共用此常量保持一致：
 * - transform-context 的 checkCompactionNeeded（触发判断）
 * - AgentInstance 构造 transformContext 时的默认值
 * - 客户端 bridge.getSessionContextUsage 返回给 UI 的 triggerThreshold
 */
export const DEFAULT_COMPACTION_TRIGGER_RATIO = 0.78;

/**
 * MicroCompact 第一级压缩触发比例。
 *
 * 在全摘要（triggerRatio=0.78）之前：当累计 token 达到上下文窗口 × 0.60 时先只清理工具结果、
 * 保留全部对话，避免一膨胀就走全摘要丢历史。
 */
export const DEFAULT_MICRO_COMPACT_RATIO = 0.6;

/** MicroCompact 默认保留的最近工具结果条数（不清理） */
export const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 8;

/** 全摘要/手动压缩默认保留的最近轮次数（会话级默认值） */
export const DEFAULT_KEEP_RECENT_TURNS = 6;

/**
 * MicroCompact 白名单：仅清理这些"幂等可重放"工具的旧结果。
 *
 * 对照 claude-code microCompact.ts COMPACTABLE_TOOLS。
 * 结构化结果工具（spawn_agent/todo_write/ask_user_question 等）不在白名单内，
 * 避免误清 Agent 仍需的关键结构化数据。
 */
export const COMPACTABLE_TOOLS: ReadonlySet<string> = new Set([
  "file_read",
  "bash",
  "grep",
  "glob",
  "web_search",
  "web_fetch",
  "file_edit",
  "file_write",
]);

// ==================== 摘要生成器 ====================

/**
 * LLM 摘要生成器（宿主注入）
 *
 * 压缩时调用独立 LLM 生成结构化摘要。
 * - `messages`：待摘要的消息列表（已剥离图片）
 * - `prompt`：摘要提示词
 * - 返回摘要文本，失败时返回 null（将降级为占位摘要）
 */
export type SummaryGeneratorFn = (
  messages: AgentMessage[],
  prompt: string,
  signal?: AbortSignal,
) => Promise<string | null>;

// ==================== 压缩事件信息 ====================

/** 压缩事件信息（通过 onCompaction 回调传递给宿主） */
export interface CompactionInfo {
  /** 压缩前估算 token 数 */
  tokensBefore: number;
  /** 压缩后估算 token 数 */
  tokensAfter: number;
  /** 触发阈值 */
  threshold: number;
  /** 压缩前消息数 */
  messagesBefore: number;
  /** 压缩后消息数 */
  messagesAfter: number;
  /** 是否使用了 LLM 摘要 */
  usedSummary: boolean;
  /** 本次摘要 PTL 重试次数（summary 策略下有效，B2） */
  ptlRetries?: number;
  /**
   * 本次压缩采用的策略（可观测）
   * - "micro"：第一级 MicroCompact，仅清工具结果、保留全部对话
   * - "summary"：全历史摘要（LLM 或占位）
   * - "hard-trim"：断路器/兜底硬截断
   * - "none"：未实际压缩（finalize 透传）
   */
  strategy?: CompactStrategy;
  /** 是否为"连续压缩链"中的再压缩（上次压缩后很快又触发，B4 诊断） */
  isRecompaction?: boolean;
  /** 距上次压缩的轮次数（-1 表示本会话首次压缩，B4 诊断） */
  turnsSincePreviousCompact?: number;
  /** 断路器当前连续失败计数（B4 诊断） */
  consecutiveFailures?: number;
}

// ==================== 策略类型 ====================

/** 压缩策略枚举 */
export type CompactStrategy = "micro" | "summary" | "hard-trim" | "none";

/** 续聊强度（B3） */
export type ResumeMode = "resume-task" | "resume-soft";

/** 部分压缩方向（B3，预留：from 保前缀 / up_to 摘要在前） */
export type PartialDirection = "from" | "up_to";

/** 摘要提示词构建选项（B3） */
export interface SummaryPromptOptions {
  activeTasks?: readonly ActiveTaskInfo[];
  domainHint?: "general" | "coding";
  /** 自定义压缩指令，追加到模板末尾 */
  customInstructions?: string;
}

/** LLM 摘要注入消息构建选项（B3） */
export interface LlmSummaryMessageOptions {
  /** memory 回查指针 */
  historyRecallHint?: boolean;
  /**
   * 当前会话标识（与 conversationId 等价，压缩时已知）。
   * 注入后回查指针引导 Agent 在 memory_search 中优先检索本会话归档。
   */
  sessionKey?: string;
  /** 告知最近消息逐字保留在摘要之后 */
  recentMessagesPreserved?: boolean;
  /** 续聊强度（默认 resume-task） */
  resumeMode?: ResumeMode;
}

/** 单级策略执行结果（管线内部传递） */
export interface CompactStageResult {
  messages: AgentMessage[];
  strategy: CompactStrategy;
  /** 该级是否实际改动了消息（false 时管线可继续尝试下一级） */
  changed: boolean;
}

// ==================== 压缩配置 ====================

export interface CompactConfig {
  /**
   * 模型的最大上下文窗口（tokens）
   * 客户端侧应由 API Server `model_providers.models[].contextWindow`（或等价字段）驱动，
   * 经 AgentInstanceConfig.contextWindow 传入 createTransformContext。
   */
  contextWindow: number;
  /** 触发压缩的比例阈值（0-1），相对「真实上下文窗口」，默认 0.78 */
  triggerRatio: number;
  /** 压缩后保留的最近消息轮数 */
  keepRecentTurns: number;
  /**
   * MicroCompact 第一级触发比例（默认 0.6）
   * 在 [microCompactRatio, triggerRatio) 区间，仅清工具结果、保留全部对话。
   */
  microCompactRatio?: number;
  /**
   * MicroCompact 保留的最近工具结果条数（默认 8，不清理）
   */
  keepRecentToolResults?: number;
  /**
   * 是否启用 MicroCompact 第一级（默认 true；killswitch 用，对齐 ENABLE_MICRO_COMPACT）
   */
  enableMicroCompact?: boolean;
  /**
   * 硬截断是否启用 API 轮次分组整轮丢弃（B1，默认 true；killswitch）。
   * true 时 hard-trim 先按轮次整组丢弃最老上下文（保持配对完整、快速逼近预算），
   * 再走逐条精修；false 回退原逐条丢弃逻辑。
   */
  useRoundBasedTrim?: boolean;
  /** 为输出保留的 token 数 */
  outputReserveTokens: number;
  /** 为摘要生成保留的 token 数 */
  summaryReserveTokens: number;
  /**
   * LLM 摘要生成器（可选）
   *
   * 提供后启用 LLM 摘要模式；不提供则降级为占位摘要（保持原有行为）。
   */
  generateSummary?: SummaryGeneratorFn;
  /**
   * 连续压缩失败后停止重试的次数（断路器）
   *
   * 默认 3。防止上下文不可压缩时每轮都浪费 API 调用。
   */
  maxConsecutiveFailures?: number;
  /**
   * 摘要请求 prompt-too-long（PTL）时的重试上限（B2，默认 3）。
   *
   * 当历史极长、连"摘要请求"本身都超模型输入上限时，丢弃最老 API 轮次后重试摘要，
   * 而非直接降级占位（占位会丢失全部历史语义）。借鉴 claude-code truncateHeadForPTLRetry。
   */
  maxPtlRetries?: number;
  /**
   * PTL 错误判断（B2，可选注入，解依赖）。
   *
   * compact 子系统不直接依赖 reliability/message-repair，由 bridge 注入
   * （通常包装 classifyLlmError(err)==="prompt_too_long"）。
   * 未注入时使用内置关键字判断（"prompt is too long"/"context_length_exceeded" 等）。
   */
  isContextLengthError?: (err: unknown) => boolean;
  /**
   * 压缩发生时的通知回调（可选）
   *
   * 宿主可用此回调向 UI 发送事件，展示压缩进度与结果。
   */
  onCompaction?: (info: CompactionInfo) => void;
  /**
   * 当前会话的活跃任务列表（可选）
   *
   * 注入到摘要提示词中，确保 LLM 摘要明确记录待处理任务，
   * 避免压缩后任务状态丢失。格式与 system-prompt-builder 的 ActiveTaskInfo 对齐。
   */
  activeTasks?: readonly { id: string; subject: string; status: string; owner?: string | null }[];
  /**
   * 摘要领域提示（可选，默认 "general"）
   *
   * 由调用方根据该会话是否启用代码类工具/技能传入。
   * "coding" 时摘要追加代码片段/函数签名/diff 要求；"general" 时不追加。
   */
  domainHint?: "general" | "coding";
  /**
   * 是否在压缩回填消息末尾追加"回查原文"指针（可选，默认 false）
   *
   * 由 bridge 在该会话注册了记忆检索工具（memory_search + memory_read）时置 true，
   * 引导 Agent 在需要被压缩掉的精确原文时用 memory_search → memory_read 回查 MemPalace 归档。
   * 避免对无记忆能力的会话给出无效指针。
   */
  historyRecallHint?: boolean;
  /**
   * 当前会话标识（可选，由宿主/AgentInstance 注入）。
   *
   * 与 conversationId 等价；压缩回填时写入回查指针，引导 memory_search 优先检索本会话。
   */
  sessionKey?: string;
  /**
   * 摘要自定义指令（B3，可选）。追加到摘要提示词模板末尾（NO_TOOLS_TRAILER 之前）。
   * 来源优先级：Hook(before_compact) > 用户会话级配置 > Agent 定义级配置。
   */
  customInstructions?: string;
  /**
   * 续聊强度（B3，默认 "resume-task"）。
   * - "resume-task"：任务型会话，直接续做不寒暄（反漂移最强，对齐 claude-code）
   * - "resume-soft"：陪伴型会话，自然继续允许轻量过渡
   */
  resumeMode?: ResumeMode;
  /**
   * 压缩后上下文重建钩子（B4，可选骨架）。
   * 注入后，summary 策略压缩后会调用 buildAttachments 并入附加消息（如工作区文件快照）。
   * 未注入时压缩行为与现状一致（零回归）。
   */
  postCompactRebuild?: PostCompactRebuild;
}

/** token 估算与阈值判断结果 */
export interface TokenEstimation {
  totalTokens: number;
  threshold: number;
  needsCompaction: boolean;
}

/** 活跃任务信息（摘要提示词注入用） */
export type ActiveTaskInfo = {
  id: string;
  subject: string;
  status: string;
  owner?: string | null;
};
