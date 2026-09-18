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
  /**
   * 最近一次「被使用」的时间：注入、合并写入、用户编辑都算（V47）。
   *
   * 与旧 `last_used` 语义相同，是下游判定（温度分档 / 冷归档 / prune / 云同步合并键）
   * 的读取列。自激的切断点不在这里，而在打分公式——`scoreMemory` 的 recency 只按
   * `created_at`，故本列被注入刷新也不会反过来抬高分数。
   */
  readonly last_injected_at: string;
  /** 被注入的次数（V47）。跨过 `skipUnusedOlderThanDays` 门控用 */
  readonly exposure_count: number;
  /**
   * 被判定为「真的用上了」的次数（V47）。
   * **P0 只记录，不参与打分**——效用代理噪声未验证（评审 §4.3 / 实施计划 P1-5）。
   */
  readonly utility_count: number;
  /** @deprecated V47 起冻结不再写入，仅作历史累积值与云同步兼容之用 */
  readonly last_used: string;
  /** @deprecated V47 起冻结不再写入；曝光语义见 `exposure_count` */
  readonly use_count: number;
  /**
   * 同主题快照的稳定键（V48）。由提取时的模型产出——**把解释工作放在写路径**，
   * 取代检测器据此比对，而不是去猜自由文本的格式（评审 §2.5.3）。
   */
  readonly project_key: string | null;
  /** 被新快照取代的时间（V48）。非空即失效：读路径排除，但保留可回放「当时为什么那么认为」 */
  readonly superseded_at: string | null;
  /** 取代者的 id（V48），指向同主题的新快照 */
  readonly superseded_by: string | null;
  /** 归档原因（V48）：'cold' | 'pruned' | 'batch' | 'user' | 'superseded' */
  readonly archive_reason: string | null;
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
  readonly last_injected_at: string;
  readonly exposure_count: number;
  readonly utility_count: number;
  /** @deprecated V47 起冻结不再写入 */
  readonly last_used: string;
  /** @deprecated V47 起冻结不再写入 */
  readonly use_count: number;
  readonly project_key: string | null;
  readonly superseded_at: string | null;
  readonly superseded_by: string | null;
  readonly archive_reason: string | null;
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
  /**
   * 相关性如何进入打分。默认 `"additive"`（现状：`… + relevanceBonus × relevance`）。
   *
   * `"multiplicative"` 把相关性改成**乘法因子** `(base + relevance) × (1 + relevanceBonus × relevance)`，
   * 让"完全不相关"的条目被整体压低、而不是只少一个加数——加法下 importance 高的
   * 陈旧条目总能靠基础分压过相关的新条目（实测：真正结案的那条排第 6，而更新鲜的
   * 中间快照排第 1）。
   *
   * **为什么做成开关而不是直接换掉**：实测数据（`injection-eval-params.real.test.ts`
   * 与 `relevance-metric.real.test.ts`）显示本语料的相对排序里 relevance 与
   * importance 的因子差只有 ~2 倍，而乘法会把这个差放到 **100 倍**——对本语料
   * （单用户单项目，判别词稀缺，相关性 top1 命中仅 12/24）很可能是过度放大噪声。
   * 开关留着是为了让这个判断**可以用数据检验**，而不是靠推理定论。
   */
  readonly relevanceMode?: "additive" | "multiplicative";
  /**
   * 相关性门控阈值，默认 0.15。上下文类记忆（project/reference/general）的
   * overlap 低于此值则不注入——把"问 A 却注入无关的 B"挡在门外。
   *
   * 做成配置是为了让它可被 `injection-eval-params.real.test.ts` 扫参：
   * 实测本语料的相关项与无关项中位排名几乎相同（8 vs 9），故"提高阈值"这个
   * 直觉需要数据回答，不能靠推理。
   */
  readonly relevanceGateThreshold?: number;
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
   * 近 24h 新建条目的保底席位数上限，默认 **2**（2026-09-18 由 5 下调）。
   * 这些席位不参与 relevance 门控（今日条目与当前话题无关也保留），
   * 保证"今天记的当天一定看得见"。设为 0 关闭保底。
   *
   * **为什么是 2 而不是 5**（`injection-eval-params.real.test.ts` 实测，25 条标注查询）：
   * | 席位 | 期望命中 | 无误注入 |
   * |---|---|---|
   * | 5（原值） | 17/25 | 22/25 |
   * | 2（现值） | **22/25** | 22/25 |
   * | 0（全关） | 5/25 | 25/25 |
   *
   * 席位越多，"今天写过但与本轮无关"的条目（学习沉淀、日常收尾记录）越容易挤掉
   * 真正相关的老条目——实测无关查询（"今天北京的天气"）下 5 个席位会把 5 条无关
   * 内容全部推进提示词。而下调到 0 会崩到 5/25：保底通道本身是必要的，只是给多了。
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
   * 注入时跳过"从未被注入过且已过期"的条目：exposure_count=0 且 created_at 早于 N 天，默认 30。
   * 只影响注入选取，不改存储数据（不归档、不删除）。设为 0 关闭。
   * V47 起判定依据由 `use_count`（曝光混同使用）改为 `exposure_count`。
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
  freshSeats24h: 2,
  recentSeats7d: 3,
  ageDecayHalfLifeDays: 21,
  ageDecayFloor: 0.4,
  useCountWeight: 0.05,
  skipUnusedOlderThanDays: 30,
  relevanceMode: "additive",
} as const;

/** 记忆读取作用域（见 AgentDefinition.memory.scope） */
export type MemoryReadScope = "agent" | "user";

/** 记忆提取候选 */
export interface ExtractedCandidate {
  readonly content: string;
  readonly category: MemoryCategory;
  readonly importance: number;
  readonly tags: readonly string[];
  /**
   * 同主题快照的稳定键（V48，可选）。仅 project 类需要产出。
   *
   * 用途：同一项目的多个进度快照（「写到第 3 篇了」「写到第 5 篇了」）用同一个 key，
   * 写入时据此把旧快照标为「被取代」——新事实取代旧事实，旧条目保留可回放。
   * 之所以由模型产出而不是代码猜：自由文本格式千变万化，正则识别实测只有 18% 命中率
   * （评审 §2.5.3）。**解释工作放在写路径**，读路径才廉价且确定。
   */
  readonly projectKey?: string;
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
