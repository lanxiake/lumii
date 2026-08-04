/**
 * Agent 定义类型
 *
 * 对齐设计文档: .qoder/design/client-agent-runtime/03-Agent定义与生命周期.md
 *
 * 统一描述系统内置 / 插件 / 模板 / 用户自建的 Agent 配置。
 * 客户端从 API Server 获取后用于构造 AgentInstance。
 */

import type { PermissionMode } from "../security/permission-types.js";

// ==================== 辅助类型 ====================

/** 模型级别 */
export type ModelTier = "basic" | "balanced" | "performance";

/**
 * Agent 来源类型
 *
 * 加载优先级: system < plugin < template < user(fork/custom)
 */
export type AgentSourceType = "system" | "plugin" | "fork" | "custom" | "template";

/**
 * 推理努力程度
 *
 * 预设字符串或 1-100 的数值
 */
export type EffortValue = "min" | "low" | "medium" | "high" | "max" | number;

/** 工具权限配置（细粒度，与 DB schema 对齐） */
export interface AgentToolPermissions {
  readonly filesystem?: {
    readonly read?: "none" | "workspace" | "user_home" | "any";
    readonly write?: "none" | "workspace" | "user_home";
    readonly execute?: boolean;
  };
  readonly network?: {
    readonly outbound?: boolean;
    readonly allowedDomains?: readonly string[];
    readonly blockedDomains?: readonly string[];
  };
  readonly delegation?: {
    readonly allowed?: boolean;
    readonly maxDepth?: number;
    readonly allowedAgentIds?: readonly string[];
  };
}

// ==================== 记忆配置 ====================

export interface MemoryConfig {
  /**
   * 记忆作用域
   * - user: 用户级（跨 Agent、跨会话持久化）
   * - conversation: 会话级（当前对话内持久化）
   * - none: 无记忆（纯无状态）
   */
  readonly scope: "user" | "conversation" | "none";
  /** 是否自动从对话中提取记忆 */
  readonly autoExtract?: boolean;
  /** 自动提取间隔（每 N 轮提取一次） */
  readonly extractEvery?: number;
}

// ==================== 主动触发 ====================

export interface ProactivityConfig {
  /** 触发条件列表 */
  readonly triggers: readonly ProactivityTrigger[];
}

export interface ProactivityTrigger {
  /** 触发器类型 */
  readonly type: "cron" | "event" | "condition";
  /** Cron 表达式（type=cron 时） */
  readonly cronExpression?: string;
  /** 事件名称（type=event 时） */
  readonly eventName?: string;
  /** 条件表达式（type=condition 时） */
  readonly condition?: string;
  /** 触发时注入的提示词 */
  readonly prompt: string;
}

// ==================== 钩子配置 ====================

export interface AgentHooksConfig {
  /** Agent 启动时执行 */
  readonly onStart?: readonly AgentHook[];
  /** 每次工具调用前执行 */
  readonly preToolUse?: readonly AgentHook[];
  /** 每次工具调用后执行 */
  readonly postToolUse?: readonly AgentHook[];
  /** Agent 正常完成时执行 */
  readonly onComplete?: readonly AgentHook[];
  /** Agent 出错时执行 */
  readonly onError?: readonly AgentHook[];
}

export interface AgentHook {
  /** 钩子类型 */
  readonly type: "command" | "script" | "rpc";
  /** 命令或脚本内容 */
  readonly command: string;
  /** 匹配条件（仅对 preToolUse/postToolUse 有效） */
  readonly toolMatch?: string;
  /** 超时时间（毫秒） */
  readonly timeoutMs?: number;
}

// ==================== AgentDefinition 核心接口 ====================

/**
 * Agent 定义
 *
 * 统一描述系统 Agent 和用户 Agent 的完整配置。
 * 所有新增字段均为 optional，不破坏现有消费者。
 */
export interface AgentDefinition {
  // ==================== 身份 ====================
  /** 主键 ID（系统 Agent 为短字符串如 "assistant"，用户 Agent 为 UUID） */
  readonly id: string;
  /** 显示名称 */
  readonly name: string;
  /** 描述 */
  readonly description?: string;
  /** 来源类型 */
  readonly sourceType: AgentSourceType;
  /** 版本号（用于热更新和迁移兼容） */
  readonly version?: number;

  // ==================== 人格 ====================
  /** 系统提示词（Agent 的核心人格定义） */
  readonly systemPrompt?: string;
  /** 人格补充（拼接到 systemPrompt 之后） */
  readonly personality?: string;
  /** 初始提示词（Agent 启动时预注入的第一条 user turn） */
  readonly initialPrompt?: string;
  /** 关键提醒（每轮对话末尾重新注入的短消息） */
  readonly criticalReminder?: string;

  // ==================== 模型 ====================
  /** @deprecated 改用 defaultPurpose（用途槽）。保留以兼容，P8 删除 */
  readonly modelTier: ModelTier;
  /**
   * Agent 默认用途槽（指向 capability_slots.slot），取代 modelTier。
   * 未设置时由消费方按 purposeFromTier(modelTier) 兜底。
   */
  readonly defaultPurpose?: string;
  /**
   * 指定模型 ID（如 "claude-sonnet-4-20250514"）
   * 为 "inherit" 时继承父 Agent 的模型
   * 为 undefined 时使用 modelTier 映射
   */
  readonly model?: string | "inherit";
  /** 思考深度级别 */
  readonly thinkingLevel?: "none" | "low" | "medium" | "high";
  /** 推理努力程度 */
  readonly effort?: EffortValue;

  // ==================== 工具策略 ====================
  /**
   * 允许使用的工具白名单
   * - ["*"] 表示全部允许
   * - undefined 表示使用默认工具集
   */
  readonly tools?: readonly string[];
  /** 禁止使用的工具黑名单（优先级高于 tools 白名单） */
  readonly disallowedTools?: readonly string[];
  /** 细粒度工具权限配置（与 DB schema 对齐） */
  readonly toolPermissions?: AgentToolPermissions;

  // ==================== 技能 ====================
  /** 预加载的技能列表（技能 ID 数组） */
  readonly skills?: readonly string[];

  // ==================== 生命周期 ====================
  /** 最大 agentic turns 数 */
  readonly maxTurns?: number;
  /**
   * 单次运行的 token 预算上限
   * @deprecated 使用 maxTokensBudget 代替
   */
  readonly maxTokensPerRun?: number;
  /** 单次运行的 token 预算上限 */
  readonly maxTokensBudget?: number;
  /** 单次运行最大工具调用次数 */
  readonly maxToolCallsPerRun?: number;
  /** 运行超时时间（毫秒） */
  readonly timeoutMs?: number;
  /** 是否默认以后台模式运行 */
  readonly background?: boolean;

  // ==================== 权限 ====================
  /**
   * 权限模式
   * - default: 标准权限（危险操作需要确认）
   * - acceptEdits: 自动接受文件编辑
   * - readOnly: 只读模式（不允许任何写操作）
   * - unrestricted: 无限制（仅限可信内置 Agent）
   * - bubble: 权限确认冒泡到父 Agent（子 Agent 使用）
   */
  readonly permissionMode?: PermissionMode;

  // ==================== 记忆 ====================
  /** 记忆配置 */
  readonly memory?: MemoryConfig;

  // ==================== 协作 ====================
  /** 子 Agent 最大并发数 */
  readonly subagentMaxConcurrent?: number;
  /** 是否可以生成子 Agent */
  readonly canSpawnSubAgents?: boolean;
  /** 允许生成的子 Agent ID 列表 */
  readonly allowedSubAgents?: readonly string[];
  /** 是否可以加入 Agent 团队协作 */
  readonly canJoinTeam?: boolean;

  // ==================== 主动触发 ====================
  /** 主动触发配置 */
  readonly proactivity?: ProactivityConfig;

  // ==================== 钩子 ====================
  /** 生命周期钩子配置 */
  readonly hooks?: AgentHooksConfig;

  // ==================== Pre-LLM Router 路由信号（v2） ====================
  /** 何时使用该 Agent（用户视角，路由 LLM 决策依据） */
  readonly whenToUse?: string
  /** 用户原话触发例子（3-10 条） */
  readonly triggerExamples?: readonly string[]
  /** 启动该 Agent 时自动激活的技能 ID 列表（"Agent 是能力包"模式） */
  readonly bundledSkills?: readonly string[]
  /** UI 展示分类（learning / writing / coding / life / other / general） */
  readonly category?: string

  // ==================== 元数据 ====================
  /** 是否激活 */
  readonly isActive: boolean;
}

// ==================== 内建 Agent 定义 ====================

/**
 * ⚠️ v13 架构：
 * - 内置 Agent 的**权威数据源**是 api-server `system_agents` 表
 *   （由 `src/db/seed/system-agents.ts` seed）。
 * - 客户端 `packages/agent-runtime/src/agent/builtin/definitions.ts` 仅存放
 *   **离线兜底镜像**，当 API 不可达时由 AgentDefinitionStore 返回。
 *
 * 运行时请统一通过 `AgentDefinitionStore.get(id)` 获取 Agent 定义。
 *
 * 为向后兼容，仍导出 `findBuiltInAgent` / `BUILT_IN_AGENTS`，内部委托到新模块。
 */
export {
  BUILTIN_AGENT_DEFINITIONS as BUILT_IN_AGENTS,
  findBuiltInAgent,
  BUILTIN_AGENT_ID_PREFIX,
  isBuiltInSubAgentId,
} from "../agent/builtin/definitions.js";
