/**
 * host-kit 类型契约 — 宿主装配层的注入接口
 *
 * 设计依据: .qoder/design/client-agent-runtime/2026-06-26-agent-standalone-v2-design.md §2.2 / §4b
 *
 * host-kit 把「组装一个可运行 AgentInstance」的纯逻辑从具体宿主（Windows bridge /
 * agent-host 进程）中抽出，宿主专属能力（事件出口、权限交互、配置来源、提示词上下文）
 * 通过下列接口注入。
 *
 * 单向依赖：host-kit 只依赖 agent-runtime 内部 + pi-*，不反向依赖 apps/*。
 */

import type { Model } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AgentRuntimeEvent } from "../types/events.js";
import type { AgentRuntimeFeatureFlags } from "../config/index.js";
import type { AgentDefinition } from "../types/agent-definition.js";
import type { MtBotTool, ToolExecutionContext } from "../types/tool.js";
import type { ToolHook } from "../tools/tool-hooks.js";
import type { MemoryManager } from "../memory/manager.js";
import type { AgentInstance } from "../agent/agent-instance.js";
import type {
  SkillInfo,
  CustomAgentInfo,
  UserDeviceInfo,
  McpServerHint,
  ContextFile,
} from "../prompt/system-prompt-builder.js";

// ============================================================
// EventSink — 事件出口
// ============================================================

/**
 * 事件出口：把 AgentRuntimeEvent 送到宿主自己的通道。
 *
 * - Windows bridge：转成 Electron IPC 事件转发到渲染进程
 * - agent-host 进程：经 event-adapter 转协议事件写 stdout
 */
export interface EventSink {
  emit(event: AgentRuntimeEvent): void;
}

// ============================================================
// PermissionProvider — 权限交互（宿主侧 UI）
// ============================================================

/**
 * 权限请求输入（对齐现有 bridge requestUserPermission 签名）。
 *
 * 策略校验（checkPermission）是内核纯逻辑，由 host-kit 的工具装配统一执行；
 * 仅当策略判定为 needs_confirmation 时，才回调本接口让宿主弹窗/IPC 询问用户。
 */
export interface PermissionRequest {
  readonly requestId: string;
  readonly runId: string;
  readonly sessionKey: string;
  readonly rootSessionKey: string;
  readonly instanceId: string;
  readonly toolName: string;
  readonly toolArgs: Record<string, unknown>;
  readonly description: string;
}

/** 用户决定（对齐现有 bridge 返回值） */
export type PermissionDecisionOutcome = "allow-once" | "allow-always" | "deny";

/**
 * 权限交互：工具执行前请求用户授权（宿主决定 UI 形态）。
 *
 * - Windows bridge：IPC 弹窗 / native dialog
 * - agent-host 进程：协议 interrupt.permission 事件 + 客户端 permission.respond 回应
 */
export interface PermissionProvider {
  requestPermission(input: PermissionRequest): Promise<PermissionDecisionOutcome>;
}

// ============================================================
// ConfigProvider — 分层配置（host 默认 + 客户端覆盖）
// ============================================================

/** provider 来源（纳入 purpose 图槽解析结果，设计 §4b） */
export type ProviderSource = "cloud" | "local" | "custom";

/** 敏感凭据：仅 host 持有，永不下发客户端 */
export interface ProviderCredentials {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  /** custom provider 槽位标识（按 id 引用，不携带 key） */
  readonly providerId?: string;
}

/** 客户端可下发的模型覆盖（仅选择，不含凭据） */
export interface ModelOverride {
  /** 显式模型 id 或 "providerKey/modelId" */
  readonly modelRef?: string;
  /** 指定 provider 来源（须为 host 已配置的来源） */
  readonly providerSource?: ProviderSource;
}

/** purpose 图槽解析结果：模型 + provider 来源 + streamFn 选择 */
export interface ResolvedModel {
  readonly model: Model<string>;
  /** 默认 "cloud" */
  readonly providerSource: ProviderSource;
  readonly streamFnKind: StreamFnKind;
}

/**
 * 配置提供者：分层配置的统一读取口。
 *
 * 安全不变量：getProviderCredentials 的返回永不出现在发往客户端的协议消息里；
 * 客户端 override 只能影响「用哪个 model / 开哪些工具」，不能携带或读取密钥。
 */
export interface ConfigProvider {
  /** 敏感配置：API key / baseURL，仅 host 持有 */
  getProviderCredentials(source: ProviderSource): ProviderCredentials;
  /**
   * purpose 图槽解析：一次给出 模型 + provider 来源 + streamFn 选择。
   * 云端来源为默认；本地 / 自定义来源预留，第一期不实现。
   */
  resolveModel(purpose: string, sessionOverride?: ModelOverride): ResolvedModel;
  /** 工具开关 / feature flags（host 默认 + 客户端 override 合并后） */
  getFeatureFlags(sessionOverride?: Partial<AgentRuntimeFeatureFlags>): AgentRuntimeFeatureFlags;
}

// ============================================================
// StreamFnFactory — streamFn 选择（gateway / direct）
// ============================================================

/** streamFn 形态：网关代理 或 本地直连 */
export type StreamFnKind = "gateway" | "direct";

/** streamFn 工厂的运行时上下文（metadata 回调等由宿主提供） */
export interface StreamFnContext {
  readonly sessionKey: string;
  readonly rootSessionKey: string;
  readonly runId: string;
  readonly purpose: string;
  readonly agentId: string;
  readonly agentName: string;
}

/**
 * streamFn 工厂：按 ResolvedModel.streamFnKind 产出对应 streamFn。
 *
 * 阶段 A 只实现 gateway 分支（包装 createGatewayStreamFn）；
 * direct 分支阶段 B 接入（pi-ai streamProxy 直连本地/自定义 provider）。
 */
export interface StreamFnFactory {
  create(resolved: ResolvedModel, ctx: StreamFnContext): StreamFn;
}

// ============================================================
// PromptContextProvider — 系统提示词上下文供给
// ============================================================

/**
 * 系统提示词上下文供给（skills/devices/soul 等，宿主侧来源不同）。
 *
 * - Windows bridge：从本地 DB / 文件加载
 * - agent-host 进程：从配置 / 注入
 */
export interface PromptContextProvider {
  getSkills(): Promise<readonly SkillInfo[]>;
  getCustomAgents(): Promise<readonly CustomAgentInfo[]>;
  getUserDevices(): Promise<readonly UserDeviceInfo[]>;
  getSoulContent(): Promise<string | undefined>;
  /**
   * 可选：每轮同步读取最新 SOUL（如移动端家长改「小主人记忆」后热更新）。
   * 若提供，assembleSystemPrompt 的 buildPrompt 优先用此值，而非装配时快照。
   */
  getSoulContentLive?: () => string | undefined;
  getContextFiles(): readonly ContextFile[];
  getMcpServerHints(): readonly McpServerHint[];
}

// ============================================================
// assembleAgent — 装配入口
// ============================================================

/**
 * 装配入口选项：所有宿主共用，输出一个就绪的 AgentInstance。
 */
export interface AssembleAgentOptions {
  readonly definition: AgentDefinition;
  readonly sessionKey: string;
  readonly conversationId?: string;
  readonly parentInstanceId?: string;
  /** 显式实例 ID（宿主可指定，未提供则 host-kit 生成） */
  readonly instanceId?: string;
  /** 用户 ID（记忆作用域） */
  readonly userId?: string;

  // ── 注入接口 ──
  readonly config: ConfigProvider;
  readonly eventSink: EventSink;
  readonly permission: PermissionProvider;
  readonly promptContext: PromptContextProvider;
  readonly streamFnFactory: StreamFnFactory;

  // ── 工具装配 ──
  /** 候选工具集（已按宿主可用性收集，host-kit 内按 definition 过滤） */
  readonly tools: readonly MtBotTool[];
  /** 工具执行上下文（平台能力注入） */
  readonly toolContext: ToolExecutionContext;
  /** 宿主增强 hooks（analytics / VCS / skill-evolution 等，可选） */
  readonly optionalHooks?: readonly ToolHook[];
  /** 客户端会话级模型覆盖（透传给 config.resolveModel） */
  readonly modelOverride?: ModelOverride;
  /** 客户端会话级 feature flags 覆盖 */
  readonly featureFlagsOverride?: Partial<AgentRuntimeFeatureFlags>;

  // ── 可选能力 ──
  readonly memoryManager?: MemoryManager;
}

/** 装配产物：宿主拿到后只需 instance.prompt(text) 并已订阅 eventSink */
export interface AssembledAgent {
  readonly instanceId: string;
  readonly instance: AgentInstance;
  /** 解析出的模型与 provider 来源（宿主可用于日志 / UI） */
  readonly resolved: ResolvedModel;
  /** 释放资源（取消事件订阅、销毁实例） */
  dispose(): void;
}
