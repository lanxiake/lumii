/**
 * 工具 Hooks 类型定义 — 统一入口/出口的横切扩展点
 */

import type { AgentToolResult, ToolCategory, ToolExecutionContext } from "../types/tool.js";

/** Hook 链路上的统一结果类型（与 MtBotTool 泛型对齐） */
export type HookAgentToolResult = AgentToolResult<unknown>;

/** 工具执行前 Hook 上下文 */
export interface ToolHookContext {
  /** 工具调用 ID */
  toolCallId: string;
  /** 工具名称 */
  toolName: string;
  /** 工具分类 */
  category: ToolCategory;
  /** 是否只读 */
  isReadOnly: boolean;
  /** 是否需要权限 */
  needsPermission: boolean;
  /** 调用参数（只读） */
  readonly params: Readonly<Record<string, unknown>>;
  /** 执行上下文 */
  context: ToolExecutionContext;
  /** 调用开始时间 */
  startTime: number;
  /** 自定义元数据（hooks 之间传递数据） */
  meta: Record<string, unknown>;
}

/** 工具成功执行后的 Hook 上下文 */
export interface ToolHookResultContext extends ToolHookContext {
  /** 工具执行结果 */
  result: HookAgentToolResult;
  /** 是否出错 */
  isError: boolean;
  /** 执行耗时（ms） */
  durationMs: number;
}

/** 工具执行出错时的 Hook 上下文 */
export interface ToolHookErrorContext extends ToolHookContext {
  /** 捕获到的错误 */
  error: unknown;
  /** 执行耗时（ms） */
  durationMs: number;
}

/**
 * 工具 Hook 定义
 *
 * beforeExecute 可：void 继续 | AgentToolResult 短路 | throw 失败
 */
export interface ToolHook {
  /** Hook 名称（调试/日志） */
  name: string;

  /**
   * 若为 true，hook 内异常将向上抛出（如权限闸门）
   * 默认 false：异常捕获后记录警告，不阻断工具执行
   */
  critical?: boolean;

  /** 工具执行前 */
  beforeExecute?: (
    ctx: ToolHookContext,
  ) => Promise<HookAgentToolResult | void> | HookAgentToolResult | void;

  /** 工具执行成功返回后 */
  afterExecute?: (
    ctx: ToolHookResultContext,
  ) => Promise<HookAgentToolResult | void> | HookAgentToolResult | void;

  /** 工具抛错时 */
  onError?: (
    ctx: ToolHookErrorContext,
  ) => Promise<HookAgentToolResult | void> | HookAgentToolResult | void;

  /** 过滤器：不提供则对所有工具生效 */
  filter?: {
    toolNames?: string[];
    categories?: ToolCategory[];
    predicate?: (toolName: string, category: ToolCategory) => boolean;
  };
}

/** 仅在调用原始 MtBotTool.execute 前后触发的生命周期（缓存短路不会调用） */
export interface ToolRunLifecycle {
  beforeActualToolExecute?: () => void;
  afterActualToolExecute?: () => void;
}
