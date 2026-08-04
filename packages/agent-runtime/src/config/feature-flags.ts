/**
 * Feature Flags — 客户端 Agent Runtime 功能开关
 */

export interface AgentRuntimeFeatureFlags {
  /** 主开关：启用客户端 Agent Runtime（默认 false，需手动开启） */
  readonly CLIENT_AGENT_RUNTIME: boolean;
  /** 启用本地工具执行（bash, file 等） */
  readonly LOCAL_TOOL_EXECUTION: boolean;
  /** 启用网络工具（web-fetch, web-search） */
  readonly WEB_TOOLS: boolean;
  /**
   * LLM 网关可重试错误（429/502 等）时自动降级到备用 tier 模型再试一次
   * （需 createGatewayStreamFn 配置 getFallbackModel）
   */
  readonly LLM_RETRY_WITH_FALLBACK: boolean;

  // --- v12 扩展：对齐 .qoder/design/client-agent-runtime/12-*.md ---

  /** 启用 Skill 激活解析器（when_to_use + pathGlobs 触发） */
  readonly ENABLE_SKILL_ACTIVATION: boolean;
  /** 启用 ask_user_question 结构化提问工具 */
  readonly ENABLE_ASK_USER_QUESTION: boolean;
  /** 启用内置 Explore/Plan/Verify 子 Agent 类型 */
  readonly ENABLE_BUILTIN_SUB_AGENTS: boolean;
  /** 启用 Coordinator 运行时（并行/聚合/失败策略沉淀到运行时） */
  readonly ENABLE_COORDINATOR_ENGINE: boolean;
  /** 启用 Plan-only 会话模式（批准前禁止写工具） */
  readonly ENABLE_PLAN_ONLY_MODE: boolean;

  // === AGENT 多轮对话优化：主题1 文件工具契约层 ===

  /** 启用 file_unchanged 去重 stub（主题1 P0-1，默认开启） */
  readonly ENABLE_FILE_READ_DEDUP: boolean;
  /** 启用 Read-before-Write 强校验（主题1 P0-4，默认开启） */
  readonly ENABLE_READ_BEFORE_WRITE: boolean;
  /** Windows mtime 抖动时回退内容哈希（主题1 P1-1，默认关闭灰度） */
  readonly ENABLE_MTIME_HASH_FALLBACK: boolean;

  // === AGENT 多轮对话优化：主题2 上下文管理层 ===

  /** 启用 MicroCompact 第一级压缩（主题2 P0-1，默认开启） */
  readonly ENABLE_MICRO_COMPACT: boolean;
  /** 启用单 turn token 预算 nudge/diminishing（主题2 P0-2，默认关闭灰度） */
  readonly ENABLE_TURN_TOKEN_BUDGET: boolean;

  // === AGENT 多轮对话优化：主题3 工具调用合理性 ===

  /** 启用工具结果落盘（主题3 P1-1，默认关闭灰度） */
  readonly ENABLE_TOOL_RESULT_PERSIST: boolean;
  /** 启用全局工具调用纪律段（主题3 P0-1，默认开启） */
  readonly ENABLE_TOOL_USAGE_GUIDANCE: boolean;

  // === AGENT 多轮对话优化：主题6 可观测性 ===

  /** 启用工具调用遥测埋点（主题6 P1-2，默认关闭灰度） */
  readonly ENABLE_TOOL_TELEMETRY: boolean;

  // === AGENT 多轮对话优化：主题5 行为约束层 ===

  /** 启用 VERDICT 解析消费（主题5 P0-1，默认开启） */
  readonly ENABLE_VERDICT_CONSUMPTION: boolean;
  /** 启用 TodoWrite verification-nudge（主题5 P0-2，默认开启） */
  readonly ENABLE_VERIFICATION_NUDGE: boolean;
  /** 启用 task_complete 验证软门禁（主题5 P0-3，默认开启） */
  readonly ENABLE_TASK_COMPLETE_GATE: boolean;
}

/** 默认 Feature Flags — 开发阶段全部开启，方便测试 */
export const DEFAULT_FEATURE_FLAGS: AgentRuntimeFeatureFlags = {
  CLIENT_AGENT_RUNTIME: true,
  LOCAL_TOOL_EXECUTION: true,
  WEB_TOOLS: true,
  LLM_RETRY_WITH_FALLBACK: false,
  // v12 扩展默认关闭，保持现网行为不变
  ENABLE_SKILL_ACTIVATION: false,
  ENABLE_ASK_USER_QUESTION: false,
  ENABLE_BUILTIN_SUB_AGENTS: false,
  ENABLE_COORDINATOR_ENGINE: false,
  ENABLE_PLAN_ONLY_MODE: false,
  // AGENT 多轮对话优化 flags（当前无用户，无需灰度，全部默认开启）
  ENABLE_FILE_READ_DEDUP: true,
  ENABLE_READ_BEFORE_WRITE: true,
  ENABLE_MTIME_HASH_FALLBACK: true,
  ENABLE_MICRO_COMPACT: true,
  ENABLE_TURN_TOKEN_BUDGET: true,
  ENABLE_TOOL_RESULT_PERSIST: true,
  ENABLE_TOOL_USAGE_GUIDANCE: true,
  ENABLE_TOOL_TELEMETRY: true,
  ENABLE_VERDICT_CONSUMPTION: true,
  ENABLE_VERIFICATION_NUDGE: true,
  ENABLE_TASK_COMPLETE_GATE: true,
} as const;

/** 创建 Feature Flags，合并用户自定义覆盖 */
export function createFeatureFlags(
  overrides?: Partial<AgentRuntimeFeatureFlags>,
): AgentRuntimeFeatureFlags {
  return { ...DEFAULT_FEATURE_FLAGS, ...overrides };
}
