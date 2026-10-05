/**
 * ToolRunner — 工具统一执行入口，串联 before/after/onError hooks
 */

import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
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
import type { AgentTurnOrigin } from "../kernel/agent-turn-types.js";
import { buildBackgroundNotice, type BackgroundToolConfig } from "./background-tool.js";

/**
 * 协调 hooks 与 MtBotTool 原始 execute 的执行器
 */
export class ToolRunner {
  private readonly globalHooks: ToolHook[] = [];
  /** 可选遥测收集器（主题6 P1-2，flag 关闭时不注入即无开销） */
  private readonly telemetry?: ToolTelemetryCollector;
  /** turn 来源 */
  private readonly origin: AgentTurnOrigin;
  /** 长耗时工具后台化（可选，宿主注入） */
  private background?: BackgroundToolConfig;

  constructor(telemetry?: ToolTelemetryCollector, origin: AgentTurnOrigin = "local_ui") {
    this.telemetry = telemetry;
    this.origin = origin;
  }

  /** 注入/清除后台化配置 */
  setBackground(background: BackgroundToolConfig | undefined): void {
    this.background = background;
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
      const isError = Boolean(shortCircuit.isError);
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

    // 标记「当前正在执行工具的实例」：后台化归属判定也依赖它（宿主 runner 读取该引用）
    lifecycle?.beforeActualToolExecute?.();

    // 长耗时工具后台化：权限闸门已放行，把真实执行挪到后台，立即返回占位结果。
    // 触发点必须在 beforeHooks（含权限闸门）之后——否则权限弹窗会晚于「已提交」出现。
    if (this.background?.policy.shouldBackground(tool.name, params)) {
      let taskId: string | undefined;
      try {
        taskId = this.background.runner.run({
          toolName: tool.name,
          label: tool.label,
          instanceId: executionContext.instanceId,
          // 后台任务用宿主注入的 signal：不沿用回合 signal，否则回合一结束任务即被 abort
          execute: (taskSignal) => tool.execute(toolCallId, params as never, taskSignal, onUpdate),
        });
      } catch (err) {
        // 登记失败不能让工具调用凭空消失，退化为同步执行
        console.warn(`[ToolRunner] 后台化登记失败，退化为同步执行 ${tool.name}:`, err);
      }
      if (taskId) {
        lifecycle?.afterActualToolExecute?.();
        const placeholder: HookAgentToolResult = {
          content: [{ type: "text", text: buildBackgroundNotice(tool.label, taskId) }],
          isError: false,
          details: { background: true, taskId },
        };
        const durationMs = Date.now() - startTime;
        const resultCtx: ToolHookResultContext = {
          ...hookCtx,
          result: placeholder,
          isError: false,
          durationMs,
        };
        return this.runAfterHooks(activeHooks, resultCtx, placeholder);
      }
    }

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
    const isError = Boolean(result.isError);
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
