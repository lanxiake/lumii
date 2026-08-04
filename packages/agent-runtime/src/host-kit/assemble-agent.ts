/**
 * assembleAgent — host-kit 总装入口
 *
 * 串起完整装配链，输出一个就绪的 AgentInstance：
 *   config.resolveModel（purpose 图槽）
 *     → streamFnFactory.create（gateway/direct）
 *     → assembleTools（过滤 + runner + hooks + 权限闸门）
 *     → assembleSystemPrompt（上下文加载 + bundledSkills + buildPrompt 闭包）
 *     → registry.create（构造 AgentInstance + 订阅 eventSink）
 *
 * 宿主只需提供四个 Provider（ConfigProvider / EventSink / PermissionProvider /
 * PromptContextProvider）+ streamFnFactory + 运行时句柄（registry / 压缩参数等），
 * 即可在任意宿主（Windows bridge / agent-host 进程）拿到可用实例。
 *
 * 设计依据: .qoder/design/client-agent-runtime/2026-06-26-agent-standalone-v2-design.md §2.2
 * 计划依据: .qoder/plan/2026-06-26-plan-A-host-kit.md §A6
 */

import { randomUUID } from "node:crypto";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AgentRegistry } from "../agent/agent-registry.js";
import type { AgentInstance } from "../agent/agent-instance.js";
import type { SummaryGeneratorFn } from "../compact/index.js";
import type { ToolRunLifecycle } from "../tools/tool-hooks.js";
import type { ToolRunnerLogger } from "../tools/hooks/logging-hook.js";
import type { PermissionMemory } from "../security/permission-memory.js";
import type { ActiveTaskInfo, WorkspaceLayout, PromptDetail } from "../prompt/system-prompt-builder.js";
import { assembleTools } from "./tool-assembly.js";
import { assembleSystemPrompt, type AssembledSystemPrompt } from "./prompt-assembly.js";
import type { AssembleAgentOptions, AssembledAgent, ResolvedModel } from "./types.js";

/**
 * 总装运行时参数（宿主持有的句柄，不属于纯注入接口，故与 AssembleAgentOptions 分开）。
 */
export interface AssembleAgentRuntime {
  /** Agent 实例注册中心（宿主单例） */
  readonly registry: AgentRegistry;
  /** 进程内「允许并记住」权限缓存（宿主持有，跨实例复用） */
  readonly permissionMemory: PermissionMemory;
  /** 当前工作目录（提示词 + 工具上下文用） */
  readonly cwd?: string;
  /** 操作系统信息（如 "win32 x64"） */
  readonly osInfo?: string;
  /** 提示词运行时信息（host / channel / thinkingLevel 等） */
  readonly runtimeInfo?: {
    readonly agentId?: string;
    readonly host?: string;
    readonly channel?: string;
    readonly thinkingLevel?: string;
  };
  /** Workspace 子目录布局 */
  readonly workspaceLayout?: WorkspaceLayout;
  /** 提示词详度（按模型 tier） */
  readonly promptDetail?: PromptDetail;
  /** 是否子 Agent（影响提示词协作段与委派约束） */
  readonly isSubAgent?: boolean;
  /** 活跃任务取值（每轮提示词重建时实时读取） */
  readonly getActiveTasks?: () => readonly ActiveTaskInfo[];

  // ── 上下文压缩参数（宿主按会话计算后注入）──
  readonly contextWindow?: number;
  readonly outputReserveTokens?: number;
  readonly summaryReserveTokens?: number;
  readonly enableMicroCompact?: boolean;
  readonly enableTurnTokenBudget?: boolean;
  /** LLM 摘要生成器（宿主用 innerStream + model 构造） */
  readonly generateSummary?: SummaryGeneratorFn;

  // ── 工具装配旁路 ──
  /** 真实 execute 前后的生命周期（如标记当前执行实例） */
  readonly toolLifecycle?: ToolRunLifecycle;
  /** 工具日志器 */
  readonly toolLogger?: ToolRunnerLogger;
  /** web 工具缓存 keyFn */
  readonly cacheKeyFn?: (toolName: string, params: Record<string, unknown>) => string;
  /** 工具遥测回调 */
  readonly onTelemetry?: (metric: {
    toolName: string;
    durationMs: number;
    success: boolean;
    errorType?: string;
  }) => void;
  /** 审计落库 */
  readonly logToolAudit?: (row: { toolName: string; resultSummary: string; isError: boolean }) => void;

  /**
   * streamFn 包装器（可选）：宿主在工厂产出的 streamFn 外再包一层
   * （如 Windows 的 per-session 模型覆盖）。缺省直接使用工厂产物。
   */
  readonly wrapStreamFn?: (inner: StreamFn, resolved: ResolvedModel) => StreamFn;
}

/** 总装产物：在 AssembledAgent 基础上额外暴露 prompt 装配结果（宿主每轮重建用） */
export interface AssembledAgentResult extends AssembledAgent {
  readonly prompt: AssembledSystemPrompt;
}

/**
 * 总装一个就绪的 AgentInstance。
 *
 * 注意：本函数只负责「装配 + 注册 + 订阅 eventSink + 设置初始提示词」。宿主专属的
 * 后续接线（记忆注入覆盖、proactivity、活动快照等）仍由宿主在拿到 AssembledAgent
 * 后自行完成——这是阶段 A 的边界（storage / memory 注入留宿主）。
 */
export async function assembleAgent(
  opts: AssembleAgentOptions,
  runtime: AssembleAgentRuntime,
): Promise<AssembledAgentResult> {
  const instanceId = opts.instanceId ?? `agent-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const def = opts.definition;
  const rootSessionKey = opts.sessionKey;

  // 1) purpose 图槽解析 → 模型 + provider 来源 + streamFn 选择
  const purpose = def.defaultPurpose ?? "chat";
  const resolved: ResolvedModel = opts.config.resolveModel(purpose, opts.modelOverride);

  // 2) streamFn 工厂产出（按 resolved.streamFnKind 分派），可选宿主包装
  const factoryStreamFn = opts.streamFnFactory.create(resolved, {
    sessionKey: opts.sessionKey,
    rootSessionKey,
    runId: instanceId,
    purpose,
    agentId: def.id,
    agentName: def.name,
  });
  const streamFn = runtime.wrapStreamFn?.(factoryStreamFn, resolved) ?? factoryStreamFn;

  // 3) feature flags（host 默认 + 客户端 override 合并）
  const featureFlags = opts.config.getFeatureFlags(opts.featureFlagsOverride);

  // 4) 工具装配（含权限闸门，用户确认走注入的 PermissionProvider）
  const assembledTools = assembleTools({
    tools: opts.tools,
    definition: def,
    toolContext: opts.toolContext,
    featureFlags,
    permissionGate: {
      definition: def,
      instanceId,
      runContext: { runId: instanceId, sessionKey: opts.sessionKey, rootSessionKey },
      permissionMemory: runtime.permissionMemory,
      permission: opts.permission,
      logToolAudit: runtime.logToolAudit,
    },
    optionalHooks: opts.optionalHooks,
    logger: runtime.toolLogger,
    lifecycle: runtime.toolLifecycle,
    cacheKeyFn: runtime.cacheKeyFn,
    onTelemetry: runtime.onTelemetry,
  });
  const toolNames = assembledTools.tools.map((t) => t.name);

  // 5) 系统提示词装配（上下文加载 + bundledSkills + buildPrompt 闭包）
  const prompt = await assembleSystemPrompt({
    definition: def,
    promptContext: opts.promptContext,
    toolNames,
    cwd: runtime.cwd,
    osInfo: runtime.osInfo,
    modelId: resolved.model.id,
    workspaceLayout: runtime.workspaceLayout,
    runtimeInfo: runtime.runtimeInfo,
    promptDetail: runtime.promptDetail,
    isSubAgent: runtime.isSubAgent,
    getActiveTasks: runtime.getActiveTasks,
  });

  // 6) 构造 AgentInstance（压缩领域提示按工具能力推断，对齐 bridge 行为）
  const hasCode =
    toolNames.includes("file_edit") || toolNames.includes("file_write") || toolNames.includes("bash");
  const hasRecall = toolNames.includes("memory_search") && toolNames.includes("memory_read");

  const instance: AgentInstance = runtime.registry.create({
    id: instanceId,
    definition: def,
    streamFn,
    model: resolved.model,
    tools: assembledTools.tools,
    parentInstanceId: opts.parentInstanceId,
    memoryManager: opts.memoryManager,
    userId: opts.userId,
    contextWindow: runtime.contextWindow,
    outputReserveTokens: runtime.outputReserveTokens,
    summaryReserveTokens: runtime.summaryReserveTokens,
    enableMicroCompact: runtime.enableMicroCompact,
    enableTurnTokenBudget: runtime.enableTurnTokenBudget,
    generateSummary: runtime.generateSummary,
    domainHint: hasCode ? "coding" : "general",
    historyRecallHint: hasRecall,
    sessionKey: opts.conversationId ?? opts.sessionKey,
  });

  // 7) 订阅 eventSink（宿主出口）
  const unsubscribe = instance.subscribe((event) => opts.eventSink.emit(event));

  // 8) 设置初始系统提示词（不含宿主记忆注入；宿主可在拿到实例后覆盖）
  instance.setSystemPrompt(prompt.initial.fullPrompt);

  return {
    instanceId,
    instance,
    resolved,
    prompt,
    dispose() {
      unsubscribe();
      runtime.registry.destroy(instanceId);
    },
  };
}
