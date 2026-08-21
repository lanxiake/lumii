/**
 * @mtbot/agent-runtime host-kit — 宿主装配层
 *
 * 把「组装一个可运行 AgentInstance」的纯逻辑从具体宿主中抽出，
 * 供 Windows bridge / agent-host 进程等多宿主复用。
 *
 * 设计依据: .qoder/design/client-agent-runtime/2026-06-26-agent-standalone-v2-design.md
 */

// 类型契约（阶段 A-1）
export type {
  EventSink,
  PermissionProvider,
  PermissionRequest,
  PermissionDecisionOutcome,
  ConfigProvider,
  ProviderSource,
  ProviderCredentials,
  ModelOverride,
  ResolvedModel,
  StreamFnContext,
  StreamFnFactory,
  PromptContextProvider,
  AssembleAgentOptions,
  AssembledAgent,
} from "./types.js";

// streamFn 工厂（本地直连）
export {
  createStreamFnFactory,
  createDirectStreamFnFactory,
} from "./stream-fn-factory.js";
export type {
  DirectStreamFnFactoryConfig,
} from "./stream-fn-factory.js";

// 工具装配（阶段 A-3）
export { assembleTools, filterToolsByDefinition } from "./tool-assembly.js";
export type { AssembleToolsOptions, AssembledTools } from "./tool-assembly.js";
export { createPermissionGateHook } from "./permission-gate-hook.js";
export type { PermissionGateHookDeps, ToolAuditRow } from "./permission-gate-hook.js";

// 提示词装配（阶段 A-5）
export { assembleSystemPrompt } from "./prompt-assembly.js";
export type {
  AssembleSystemPromptOptions,
  AssembledSystemPrompt,
  SystemPromptBuilder,
} from "./prompt-assembly.js";

// 总装入口（阶段 A-6）
export { assembleAgent } from "./assemble-agent.js";
export type { AssembleAgentRuntime, AssembledAgentResult } from "./assemble-agent.js";
