/**
 * Agent Kernel 协议 DTO
 *
 * 定义 AgentTurnOrigin、AgentTurnRequest、AgentTurnEvent、AgentTurnResult
 * 以及 AgentKernelModelInfo，是 AgentKernel 接口（agent-runtime 内部）的核心类型。
 * 不依赖 pi-agent-core。
 */

/**
 * Turn 来源标识
 *
 * 用于权限决策：不同 origin 暴露不同的能力集合。
 * - local_ui     : 来自本机 Windows/macOS 客户端 UI
 * - cloud_channel: 来自云通道（WeChat、Slack、REST webhook 等）
 * - subagent     : 来自父 Agent 通过 spawn_agent 工具触发
 * - scheduled    : 来自定时任务调度器
 * - internal     : 来自系统内部（自愈重试、proactivity 等）
 */
export type AgentTurnOrigin =
  | "local_ui"
  | "cloud_channel"
  | "subagent"
  | "scheduled"
  | "internal";

/**
 * 启动一个 turn 所需的最小参数
 */
export interface AgentTurnRequest {
  /** 用户输入文本 */
  message: string;
  /** 可选多模态图片（base64 + mimeType） */
  images?: Array<{
    data: string;
    mimeType: string;
  }>;
  /** turn 来源（未传时 kernel 使用 local_ui） */
  origin?: AgentTurnOrigin;
  /** 可选取消信号 */
  signal?: AbortSignal;
}

/**
 * Kernel 向订阅者发出的流式事件
 */
export type AgentTurnEvent =
  | { type: "turn:start" }
  | { type: "turn:delta"; delta: string; fullText: string }
  | { type: "turn:thinking"; delta: string }
  | {
      type: "turn:tool_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "turn:tool_end";
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError?: boolean;
    }
  | {
      type: "turn:end";
      fullText: string;
      usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheRead?: number;
        cacheWrite?: number;
      };
    }
  | { type: "turn:error"; error: string; code?: string; retryable?: boolean }
  | { type: "turn:cancelled" };

/**
 * startTurn() 完成后返回的摘要结果
 */
export interface AgentTurnResult {
  /** 最终完整文本 */
  fullText: string;
  /** turn 是否被取消 */
  cancelled: boolean;
  /** 如果出错，错误信息 */
  error?: string;
  /** token 用量 */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

/**
 * Kernel 报告的单个模型信息
 */
export interface AgentKernelModelInfo {
  /** 模型 ID（如 "claude-3-5-sonnet-20241022"） */
  id: string;
  /** 显示名称 */
  label?: string;
  /** 上下文窗口（tokens） */
  contextWindow?: number;
  /** 是否为当前默认模型 */
  isDefault?: boolean;
}
