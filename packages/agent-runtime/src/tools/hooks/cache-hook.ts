/**
 * 通用 TTL 缓存 Hook — 按工具名过滤，命中时短路执行
 */

import type { HookAgentToolResult, ToolHook } from "../tool-hooks.js";

/** 创建基于内存 Map 的 TTL 缓存 hook */
export function createCacheHook(options: {
  /** 缓存 key */
  keyFn: (toolName: string, params: Record<string, unknown>) => string;
  /** TTL（ms） */
  ttlMs: number;
  /** 仅对这些工具生效 */
  toolNames?: string[];
}): ToolHook {
  const cache = new Map<string, { value: HookAgentToolResult; expiresAt: number }>();

  return {
    name: "cache",
    filter: options.toolNames ? { toolNames: options.toolNames } : undefined,
    beforeExecute(ctx) {
      const key = options.keyFn(ctx.toolName, ctx.params as Record<string, unknown>);
      const entry = cache.get(key);
      if (entry && Date.now() < entry.expiresAt) {
        return entry.value;
      }
    },
    afterExecute(ctx) {
      const key = options.keyFn(ctx.toolName, ctx.params as Record<string, unknown>);
      cache.set(key, { value: ctx.result, expiresAt: Date.now() + options.ttlMs });
    },
  };
}
