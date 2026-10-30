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

  // --- v12 扩展：对齐 .qoder/design/client-agent-runtime/12-*.md ---

  /** 启用 Skill 激活解析器（when_to_use + pathGlobs 触发） */
  readonly ENABLE_SKILL_ACTIVATION: boolean;

  /**
   * 灰度名单：只有这些 Agent 定义 id（`chronicler`）走激活解析，其余维持
   * `ENABLE_SKILL_ACTIVATION` 的全局值。
   *
   * **为什么需要它**：`ENABLE_SKILL_ACTIVATION` 从 v12 起默认关闭，理由已查不到记录
   * （`feature-flags.ts` 只写"保持现网行为不变"）。直接翻成 true 等于一次性
   * 改动所有 Agent 的技能可见面——那是本仓库最不该做的一种改动。
   * 有了名单就能先挑一个低风险 Agent 观察一周，再决定要不要全量。
   *
   * 空数组（默认）= 只受全局开关控制，行为与引入前逐字一致。
   */
  readonly ENABLE_SKILL_ACTIVATION_FOR: readonly string[];

  /**
   * 工具装载裁剪（P2 能力面治理）灰度名单：**只有这些 Agent 定义 id** 走
   * `resolveToolLoadout`（按 (agent, channel) 的 LRU 常驻 20 个，其余折叠进 `tool_search`）。
   *
   * **默认空** = 全量装载，行为与引入前逐字一致。这与 `ENABLE_SKILL_ACTIVATION_FOR`
   * 同一套路数，但更必要：裁工具会改变**模型可见面**，而回放的 93.5% Recall 是上界
   * （设计 §5.6.6）——上线前必须先在单个低风险 Agent 上 A/B（计划 C9）。
   * 名单为空就是那条回滚路径：出问题把它清空即可，不必回滚代码。
   */
  readonly ENABLE_TOOL_LOADOUT_FOR: readonly string[];

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
  // v12 扩展默认关闭，保持现网行为不变
  ENABLE_SKILL_ACTIVATION: false,
  // 空名单 = 只受上面的全局开关控制，行为与引入前逐字一致
  ENABLE_SKILL_ACTIVATION_FOR: [],
  // 空名单 = 不裁剪（P2 灰度；见接口注释的 C9 与回滚理由）
  ENABLE_TOOL_LOADOUT_FOR: [],
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
