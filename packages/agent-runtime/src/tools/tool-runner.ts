/**
 * ToolRunner — 工具统一执行入口，串联 before/after/onError hooks
 */

import type { AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { MtBotTool, ToolExecutionContext } from "../types/tool.js";
import type {
  HookAgentToolResult,
  ToolHook,
  ToolHookContext,
  ToolHookErrorContext,
  ToolHookResultContext,
  ToolRunLifecycle,
} from "./tool-hooks.js";
import { reportToolMetrics, type ToolTelemetryCollector } from "./telemetry.js";
import type { CapabilityRegistry } from "../capability/capability-registry.js";
import type { AgentTurnOrigin } from "@mtbot/protocol";

/**
 * 协调 hooks 与 MtBotTool 原始 execute 的执行器
 */
export class ToolRunner {
  private readonly globalHooks: ToolHook[] = [];
  /** 可选遥测收集器（主题6 P1-2，flag 关闭时不注入即无开销） */
  private readonly telemetry?: ToolTelemetryCollector;
  /** 可选能力注册表：执行前查询 descriptor 并注入 meta，供 hooks 访问 */
  private readonly capabilityRegistry?: CapabilityRegistry;
  /** turn 来源（用于 capability 权限元数据记录） */
  private readonly origin: AgentTurnOrigin;

  constructor(telemetry?: ToolTelemetryCollector, capabilityRegistry?: CapabilityRegistry, origin: AgentTurnOrigin = "local_ui") {
    this.telemetry = telemetry;
    this.capabilityRegistry = capabilityRegistry;
    this.origin = origin;
  }

  /** 注册全局 hook（按注册顺序执行） */
  addHook(hook: ToolHook): void {
    this.globalHooks.push(hook);
  }

  /** 按名称移除 hook */
  removeHook(name: string): void {
    const idx = this.globalHooks.findIndex((h) => h.name === name);
    if (idx >= 0) {
      this.globalHooks.splice(idx, 1);
    }
  }

  /**
   * 执行工具：before →（可选真实 execute）→ after；抛错时 onError
   */
  async run(
    tool: MtBotTool,
    executionContext: ToolExecutionContext,
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback,
    lifecycle?: ToolRunLifecycle,
  ): Promise<HookAgentToolResult> {
    const startTime = Date.now();
    const hookCtx: ToolHookContext = {
      toolCallId,
      toolName: tool.name,
      category: tool.category,
      isReadOnly: tool.isReadOnly,
      needsPermission: tool.needsPermission,
      params: Object.freeze({ ...params }),
      context: executionContext,
      startTime,
      meta: {
        origin: this.origin,
        capabilityDescriptor: this.capabilityRegistry?.get(tool.name),
      },
    };

    const activeHooks = this.globalHooks.filter((h) => this.matchesFilter(h, tool));

    let shortCircuit: HookAgentToolResult | undefined;
    for (const hook of activeHooks) {
      if (!hook.beforeExecute) {
        continue;
      }
      const out = await this.invokeHook(hook, () => hook.beforeExecute!(hookCtx), "beforeExecute");
      if (out !== undefined) {
        shortCircuit = out;
        break;
      }
    }

    if (shortCircuit !== undefined) {
      const durationMs = Date.now() - startTime;
      const isError = Boolean((shortCircuit as { isError?: boolean }).isError);
      if (this.telemetry) {
        reportToolMetrics(this.telemetry, tool.name, durationMs, isError);
      }
      const resultCtx: ToolHookResultContext = {
        ...hookCtx,
        result: shortCircuit,
        isError,
        durationMs,
      };
      return this.runAfterHooks(activeHooks, resultCtx, shortCircuit);
    }

    lifecycle?.beforeActualToolExecute?.();
    let result: HookAgentToolResult;
    try {
      result = await tool.execute(toolCallId, params as never, signal, onUpdate);
    } catch (err) {
      const durationMs = Date.now() - startTime;
      lifecycle?.afterActualToolExecute?.();
      if (this.telemetry) {
        reportToolMetrics(this.telemetry, tool.name, durationMs, true, err);
      }
      const errCtx: ToolHookErrorContext = { ...hookCtx, error: err, durationMs };

      for (const hook of activeHooks) {
        if (!hook.onError) {
          continue;
        }
        const fallback = await this.invokeHook(hook, () => hook.onError!(errCtx), "onError");
        if (fallback !== undefined) {
          return fallback;
        }
      }
      throw err;
    }
    lifecycle?.afterActualToolExecute?.();

    const durationMs = Date.now() - startTime;
    const isError = Boolean((result as { isError?: boolean }).isError);
    if (this.telemetry) {
      reportToolMetrics(this.telemetry, tool.name, durationMs, isError);
    }
    const resultCtx: ToolHookResultContext = {
      ...hookCtx,
      result,
      isError,
      durationMs,
    };
    return this.runAfterHooks(activeHooks, resultCtx, result);
  }

  /**
   * 依次执行 afterExecute，允许修改最终结果
   */
  private async runAfterHooks(
    hooks: ToolHook[],
    ctx: ToolHookResultContext,
    initial: HookAgentToolResult,
  ): Promise<HookAgentToolResult> {
    let current = initial;
    for (const hook of hooks) {
      if (!hook.afterExecute) {
        continue;
      }
      const modified = await this.invokeHook(
        hook,
        () => hook.afterExecute!({ ...ctx, result: current }),
        "afterExecute",
      );
      if (modified !== undefined) {
        current = modified;
      }
    }
    return current;
  }

  /**
   * 执行单个 hook 回调；按 critical 决定是否吞掉异常
   */
  private async invokeHook<T>(
    hook: ToolHook,
    fn: () => Promise<T | void> | T | void,
    phase: string,
  ): Promise<T | void> {
    try {
      return await fn();
    } catch (err) {
      if (hook.critical) {
        throw err;
      }
      console.warn(`[ToolRunner] hook "${hook.name}" ${phase} failed:`, err);
      return undefined;
    }
  }

  /** 判断 hook 是否适用于当前工具 */
  private matchesFilter(hook: ToolHook, tool: MtBotTool): boolean {
    if (!hook.filter) {
      return true;
    }
    const { toolNames, categories, predicate } = hook.filter;
    if (toolNames && !toolNames.includes(tool.name)) {
      return false;
    }
    if (categories && !categories.includes(tool.category)) {
      return false;
    }
    if (predicate && !predicate(tool.name, tool.category)) {
      return false;
    }
    return true;
  }
}
