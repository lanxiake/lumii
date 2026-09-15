/**
 * 记忆系统类型定义
 */

/** 记忆类别 */
export type MemoryCategory = "user" | "feedback" | "project" | "reference" | "general";

/** 个人记忆类别（提取后写入 user_memory Markdown，不存 SQLite） */
const PERSONAL_CATEGORIES: ReadonlySet<MemoryCategory> = new Set(["user", "feedback"]);

/** 判断是否为个人记忆分类 */
export function isPersonalCategory(category: MemoryCategory): boolean {
  return PERSONAL_CATEGORIES.has(category);
}

/** 记忆条目 */
export interface MemoryEntry {
  readonly id: string;
  readonly agent_id: string;
  readonly user_id: string;
  readonly category: MemoryCategory;
  readonly content: string;
  readonly importance: number;
  readonly tags: readonly string[];
  readonly source_message_id: string | null;
  /** 来源段 ID（段锚定原文区间，可经 loadSegmentText 回读）。诉求 A 核心锚点 */
  readonly source_segment_id: string | null;
  /** 对应的记忆宫殿 drawer 稳定 ID（内容寻址），可空 */
  readonly palace_drawer_id: string | null;
  readonly created_at: string;
  readonly last_used: string;
  readonly use_count: number;
  readonly is_archived: boolean;
}

/** 数据库行类型（原始 SQLite 格式） */
export interface MemoryRow {
  readonly id: string;
  readonly agent_id: string;
  readonly user_id: string;
  readonly category: string;
  readonly content: string;
  readonly importance: number;
  readonly tags: string | null;
  readonly source_message_id: string | null;
  readonly source_segment_id: string | null;
  readonly palace_drawer_id: string | null;
  readonly created_at: string;
  readonly last_used: string;
  readonly use_count: number;
  readonly is_archived: number;
}

/** 热记忆配置 */
export interface HotMemoryConfig {
  /** 最大注入条数 */
  readonly maxItems: number;
  /** 最大 token 预算（粗估按字符数 / 4） */
  readonly maxTokenBudget: number;
  /** 类别优先级权重 */
  readonly categoryWeights: Readonly<Record<MemoryCategory, number>>;
  /** 相关性加分权重（query 与记忆内容 overlap 的系数），默认 2.0（2026-09-13 由 1.0 提高，排序更偏向相关） */
  readonly relevanceBonus?: number;
  /** recency 加分权重，默认 0.1（P0 新增，原硬编码于 loadTopMemories） */
  readonly recencyWeight?: number;
  /** recency 加分衰减到 0 所需天数，默认 30（P0 新增，原硬编码于 loadTopMemories） */
  readonly recencyHalfLifeDays?: number;
  /** query 有效 token 下限：低于此值跳过相关性、退化为标量评分，默认 2 */
  readonly minQueryTokens?: number;
  /**
   * 有有效 query 时，是否对上下文类记忆（project/reference/general）做相关性门控：
   * 与当前对话完全无关（overlap=0）则不注入。画像类（user/feedback）不受影响、始终保留。
   * 默认 true。避免"问 A 却注入无关的 B 记忆"。
   */
  readonly gateContextualByRelevance?: boolean;

  // ==================== 时间感知席位（2026-09-15） ====================
  // 背景：纯 score 排序下，新条目（importance 默认 0.5）会被历史高 importance 条目
  // 永久挤出注入席位，导致"今天记的当天看不见"。席位是绕过 score 的保底通道，
  // 只按 created_at 判定（不可变字段），不按 last_used —— 后者每次注入都被刷新，
  // 用它做保底会形成"注入过的更容易再被注入"的自激循环。

  /**
   * 近 24h 新建条目的保底席位数上限，默认 5。
   * 这些席位不参与 relevance 门控（今日条目与当前话题无关也保留），
   * 保证"今天记的当天一定看得见"。设为 0 关闭保底。
   */
  readonly freshSeats24h?: number;
  /** 近 7d 新建条目的次级席位数上限，默认 3（用剩余席位，同样免门控）。 */
  readonly recentSeats7d?: number;
  /**
   * importance 项的年龄衰减半衰期（天），默认 21。
   * `importance * categoryWeights * max(floor, 0.5^(ageDays/halfLife))`，
   * 让同年份的高 importance 旧条目不再无条件碾压新条目。基于 created_at。
   */
  readonly ageDecayHalfLifeDays?: number;
  /** 年龄衰减下限系数，默认 0.4（防止老条目基础分完全归零）。 */
  readonly ageDecayFloor?: number;
  /** use_count 轻微加成权重，默认 0.05：`min(0.15, w * ln(1 + use_count))`。 */
  readonly useCountWeight?: number;
  /**
   * 注入时跳过"从未被用过且已过期"的条目：use_count=0 且 created_at 早于 N 天，默认 30。
   * 只影响注入选取，不改存储数据（不归档、不删除）。设为 0 关闭。
   */
  readonly skipUnusedOlderThanDays?: number;
}

/** 默认热记忆配置 */
export const DEFAULT_HOT_MEMORY_CONFIG: HotMemoryConfig = {
  maxItems: 6,
  maxTokenBudget: 1024,
  categoryWeights: {
    user: 1.2,
    feedback: 1.5,
    project: 1.0,
    reference: 0.8,
    general: 0.6,
  },
  relevanceBonus: 2.0,
  recencyWeight: 0.1,
  recencyHalfLifeDays: 30,
  minQueryTokens: 2,
  gateContextualByRelevance: true,
  freshSeats24h: 5,
  recentSeats7d: 3,
  ageDecayHalfLifeDays: 21,
  ageDecayFloor: 0.4,
  useCountWeight: 0.05,
  skipUnusedOlderThanDays: 30,
} as const;

/** 记忆读取作用域（见 AgentDefinition.memory.scope） */
export type MemoryReadScope = "agent" | "user";

/** 记忆提取候选 */
export interface ExtractedCandidate {
  readonly content: string;
  readonly category: MemoryCategory;
  readonly importance: number;
  readonly tags: readonly string[];
}

/** 记忆提取编排器配置 */
export interface ExtractionOrchestratorConfig {
  /** LLM 提取间隔（每 N 轮对话触发一次） */
  readonly llmExtractInterval: number;
  /** 规则提取是否启用 */
  readonly ruleExtractEnabled: boolean;
  /** LLM 提取是否启用 */
  readonly llmExtractEnabled: boolean;
}
