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
  /** 相关性加分权重（query 与记忆内容 overlap 的系数），默认 1.0 */
  readonly relevanceBonus?: number;
  /** query 有效 token 下限：低于此值跳过相关性、退化为标量评分，默认 2 */
  readonly minQueryTokens?: number;
  /**
   * 有有效 query 时，是否对上下文类记忆（project/reference/general）做相关性门控：
   * 与当前对话完全无关（overlap=0）则不注入。画像类（user/feedback）不受影响、始终保留。
   * 默认 true。避免"问 A 却注入无关的 B 记忆"。
   */
  readonly gateContextualByRelevance?: boolean;
}

/** 默认热记忆配置 */
export const DEFAULT_HOT_MEMORY_CONFIG: HotMemoryConfig = {
  maxItems: 20,
  maxTokenBudget: 1024,
  categoryWeights: {
    user: 1.2,
    feedback: 1.5,
    project: 1.0,
    reference: 0.8,
    general: 0.6,
  },
  relevanceBonus: 1.0,
  minQueryTokens: 2,
  gateContextualByRelevance: true,
} as const;

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
