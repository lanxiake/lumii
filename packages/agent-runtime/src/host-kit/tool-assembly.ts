/**
 * 工具装配 — 把候选工具集组装成可注入 Agent 的 AgentTool[]
 *
 * 从 apps/windows bridge-instance-factory.ts 行 258-397 搬运的「纯装配」逻辑：
 * 按定义过滤工具 → new ToolRunner → 按 flags 加通用 hooks → 注入宿主专属 hooks →
 * wrapMtBotToolsWithRunner。
 *
 * 宿主专属能力通过参数注入：
 * - 用户确认：PermissionProvider（permission-gate hook 内部调用）
 * - analytics / skill-hit-rate / large-result / VCS 等：optionalHooks
 *
 * 设计依据: .qoder/design/client-agent-runtime/2026-06-26-agent-standalone-v2-design.md §2.2
 * 计划依据: .qoder/plan/2026-06-26-plan-A-host-kit.md §A3
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { MtBotTool, ToolExecutionContext } from "../types/tool.js";
import type { AgentDefinition } from "../types/agent-definition.js";
import type { AgentRuntimeFeatureFlags } from "../config/feature-flags.js";
import type { ToolHook, ToolRunLifecycle } from "../tools/tool-hooks.js";
import { ToolRunner } from "../tools/tool-runner.js";
import { wrapMtBotToolsWithRunner } from "../tools/tool-registry.js";
import { ToolTelemetryCollector } from "../tools/telemetry.js";
import { createLoggingHook, type ToolRunnerLogger } from "../tools/hooks/logging-hook.js";
import { createCacheHook } from "../tools/hooks/cache-hook.js";
import { createReadBeforeWriteHook } from "../tools/hooks/read-before-write-hook.js";
import { createToolResultPersistHook } from "../tools/hooks/tool-result-persist-hook.js";
import { createVerificationGateHook } from "../agent/hooks/verification-gate-hook.js";
import { DEFAULT_CACHE_TTL_MINUTES, normalizeCacheKey } from "../tools/built-in/web-shared.js";
import { WRITE_TOOL_NAMES } from "../security/permission-types.js";
import { createPermissionGateHook, type PermissionGateHookDeps } from "./permission-gate-hook.js";

/**
 * 按 Agent 定义过滤工具列表
 *
 * 优先级: canSpawnSubAgents > tools 白名单 > disallowedTools 黑名单 > readOnly 模式过滤
 * （搬自 bridge-utils.ts filterToolsByDefinition，行为一致）
 */
export function filterToolsByDefinition<T extends AgentTool>(
  allTools: readonly T[],
  def: AgentDefinition,
): T[] {
  let filtered: T[] = [...allTools];

  if (def.canSpawnSubAgents === false) {
    filtered = filtered.filter((t) => t.name !== "spawn_agent" && t.name !== "send_message");
  }
  if (def.tools && !def.tools.includes("*")) {
    const whiteset = new Set(def.tools);
    filtered = filtered.filter((t) => whiteset.has(t.name));
  }
  if (def.disallowedTools?.length) {
    const blackset = new Set(def.disallowedTools);
    filtered = filtered.filter((t) => !blackset.has(t.name));
  }
  if (def.permissionMode === "readOnly") {
    filtered = filtered.filter((t) => !WRITE_TOOL_NAMES.has(t.name));
  }
  return filtered;
}

/** web 工具缓存的默认 keyFn（搬自 bridge，对 web_search / web_fetch 规范化 key） */
function defaultWebCacheKeyFn(toolName: string, params: Record<string, unknown>): string {
  if (toolName === "web_search") {
    const q = String((params as { query?: unknown }).query ?? "");
    const count = Number((params as { count?: unknown }).count ?? 8);
    const lang = String((params as { language?: unknown }).language ?? "zh-CN");
    return normalizeCacheKey(`${toolName}:${q}:${count}:${lang}`);
  }
  if (toolName === "web_fetch") {
    const url = String((params as { url?: unknown }).url ?? "");
    const mode = String((params as { extractMode?: unknown }).extractMode ?? "markdown");
    const maxChars = Number((params as { maxChars?: unknown }).maxChars ?? 20000);
    return normalizeCacheKey(`${toolName}:${url}:${mode}:${maxChars}`);
  }
  return normalizeCacheKey(JSON.stringify([toolName, params]));
}

/** 工具装配入参 */
export interface AssembleToolsOptions {
  /** 候选工具集（宿主已收集，按 definition 在此过滤） */
  readonly tools: readonly MtBotTool[];
  /** Agent 定义（用于过滤与权限模式） */
  readonly definition: AgentDefinition;
  /** 工具执行上下文（平台能力注入） */
  readonly toolContext: ToolExecutionContext;
  /** feature flags（决定开哪些 hook） */
  readonly featureFlags: AgentRuntimeFeatureFlags;
  /** 权限闸门依赖（用户确认走注入的 PermissionProvider） */
  readonly permissionGate: PermissionGateHookDeps;
  /** 宿主专属增强 hooks（analytics / skill-hit-rate / large-result / VCS 等），按数组顺序插入 */
  readonly optionalHooks?: readonly ToolHook[];
  /** 日志器（注入宿主 logger，缺省 console） */
  readonly logger?: ToolRunnerLogger;
  /** 真实 execute 前后的生命周期（如标记当前执行实例） */
  readonly lifecycle?: ToolRunLifecycle;
  /** web 工具缓存 keyFn（缺省按 web_search/web_fetch 规范化） */
  readonly cacheKeyFn?: (toolName: string, params: Record<string, unknown>) => string;
  /** 遥测回调（仅 ENABLE_TOOL_TELEMETRY 时生效） */
  readonly onTelemetry?: (metric: {
    toolName: string;
    durationMs: number;
    success: boolean;
    errorType?: string;
  }) => void;
}

/** 工具装配产物 */
export interface AssembledTools {
  /** 已包裹 runner 的工具（可直接注入 Agent） */
  readonly tools: AgentTool[];
  /** 过滤后的原始 MtBotTool 数量（过滤前=入参 tools.length） */
  readonly enabledCount: number;
  /** 内部 runner（宿主如需后续动态加/减 hook 可用） */
  readonly runner: ToolRunner;
}

/**
 * 装配工具：过滤 → runner + hooks（顺序与 Windows bridge 完全一致）→ wrap。
 *
 * hook 顺序（保持与 bridge 一致以零行为变化）：
 *   permission-gate → [read-before-write] → [verification-gate] →
 *   [tool-result-persist] → logging → ...optionalHooks → cache(web)
 */
export function assembleTools(opts: AssembleToolsOptions): AssembledTools {
  const filtered = filterToolsByDefinition(opts.tools, opts.definition);

  const telemetryCollector = opts.featureFlags.ENABLE_TOOL_TELEMETRY
    ? new ToolTelemetryCollector((metric) => {
        opts.onTelemetry?.({
          toolName: metric.toolName,
          durationMs: metric.durationMs,
          success: metric.success,
          errorType: metric.errorType,
        });
      })
    : undefined;

  const runner = new ToolRunner(telemetryCollector);

  // 1) 权限闸门（critical）
  runner.addHook(createPermissionGateHook(opts.permissionGate));
  // 2) Read-before-Write（灰度 flag）
  if (opts.featureFlags.ENABLE_READ_BEFORE_WRITE) {
    runner.addHook(
      createReadBeforeWriteHook({
        enableMtimeHashFallback: opts.featureFlags.ENABLE_MTIME_HASH_FALLBACK,
      }),
    );
  }
  // 3) task_complete 验证软门禁（flag）
  if (opts.featureFlags.ENABLE_TASK_COMPLETE_GATE) {
    runner.addHook(createVerificationGateHook());
  }
  // 4) 大工具结果落盘（flag）
  if (opts.featureFlags.ENABLE_TOOL_RESULT_PERSIST) {
    runner.addHook(createToolResultPersistHook());
  }
  // 5) 日志
  runner.addHook(createLoggingHook(opts.logger));
  // 6) 宿主专属增强 hooks（analytics / large-result / skill-hit-rate / VCS …）
  for (const hook of opts.optionalHooks ?? []) {
    runner.addHook(hook);
  }
  // 7) web 工具缓存
  runner.addHook(
    createCacheHook({
      ttlMs: DEFAULT_CACHE_TTL_MINUTES * 60 * 1000,
      toolNames: ["web_search", "web_fetch"],
      keyFn: opts.cacheKeyFn ?? defaultWebCacheKeyFn,
    }),
  );

  const wrapped = wrapMtBotToolsWithRunner(filtered, runner, opts.toolContext, opts.lifecycle);

  return { tools: wrapped, enabledCount: filtered.length, runner };
}
