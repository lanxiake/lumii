/**
 * 日志 Hook — 统一工具调用轨迹（可注入 Logger）
 */

import type { ToolHook } from "../tool-hooks.js";

/** 极简日志接口，便于接入 bridge 的 agentRuntimeLog */
export interface ToolRunnerLogger {
  log: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

/**
 * 创建日志 Hook：before/after/onError 输出工具名、耗时与参数摘要
 */
export function createLoggingHook(logger?: ToolRunnerLogger): ToolHook {
  const log = logger ?? console;
  const errLog = logger?.error ?? console.error;

  return {
    name: "logging",
    beforeExecute(ctx) {
      const paramPreview = JSON.stringify(ctx.params).slice(0, 200);
      log.log(
        `[ToolRunner] → ${ctx.toolName} (${ctx.toolCallId.slice(0, 8)}) params=${paramPreview}`,
      );
    },
    afterExecute(ctx) {
      log.log(`[ToolRunner] ← ${ctx.toolName} durationMs=${ctx.durationMs} isError=${ctx.isError}`);
    },
    onError(ctx) {
      errLog(
        `[ToolRunner] ✗ ${ctx.toolName} durationMs=${ctx.durationMs} error=${ctx.error instanceof Error ? ctx.error.message : String(ctx.error)}`,
      );
    },
  };
}
