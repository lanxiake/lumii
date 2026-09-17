/**
 * MemoryManager — 记忆模块门面
 *
 * 统一封装 AgentMemoryRepo、规则提取与 prompt 注入，供 AgentInstance 与宿主进程复用。
 */

import type { AgentMemoryRepo } from "./memory-repo.js";
import type { SegmentRepo, MemorySegment } from "../storage/segment-repo.js";
import type { ConversationRepo } from "../storage/conversation-repo.js";
import {
  extractByRules,
  extractByLLM,
  logRejections,
  validateCandidates,
  type ExistingMemoryContext,
} from "./memory-extractor.js";
import {
  consolidateExistingPersonalMemory,
  needsPersonalMemoryConsolidation,
} from "./memory-consolidation.js";
import { injectMemories, stripMemoryPlaceholder } from "./memory-injector.js";
import { mergeCandidates } from "./merge.js";
import {
  computeContribution,
  type MemoryInjectionOutcome,
} from "./memory-feedback-repo.js";
import type {
  MemoryEntry,
  MemoryCategory,
  HotMemoryConfig,
  MemoryReadScope,
  ExtractedCandidate,
} from "./types.js";
import { DEFAULT_HOT_MEMORY_CONFIG, isPersonalCategory } from "./types.js";

/** MemoryManager 构造选项 */
export interface MemoryManagerOptions {
  /**
   * 提取到 user/feedback 个人记忆时触发。
   * 调用方（bridge）负责将内容整理合并到 user_memory Markdown 文档。
   * 不抛出异常，失败由调用方处理。
   */
  onPersonalMemoryExtracted?: (candidates: readonly ExtractedCandidate[]) => void;
  /**
   * LLM 调用回调（可选）
   *
   * 提供后启用 LLM 辅助记忆提取。由 AgentInstance 在 agent_end 时异步调用。
   */
  callLLM?: (prompt: string, context?: { purpose?: string }) => Promise<string>;
  /**
   * 读取个人记忆 Markdown 全文（可选）
   *
   * 提供后 LLM 提取/段落总结会将历史个人记忆一并传给 AI 做去重与冲突判断。
   */
  getPersonalMemory?: () => Promise<string | undefined>;
  /** 写回整理后的个人记忆 Markdown（可选） */
  updatePersonalMemory?: (content: string) => Promise<void>;
  /** 段仓库（可选）：提供后支持来源下转（getMemoryProvenance） */
  segmentRepo?: SegmentRepo;
  /** 对话仓库（可选）：提供后来源下转可回读原文区间 */
  conversationRepo?: ConversationRepo;
}

/** 记忆来源溯源结果（诉求 A：工作记忆 → 来源段 → 原文区间 + 宫殿片段） */
export interface MemoryProvenance {
  readonly memoryId: string;
  readonly sourceSegmentId: string | null;
  readonly sourceMessageId: string | null;
  /** 该记忆对应的宫殿语义片段（内容寻址 drawer_id） */
  readonly palaceDrawerId: string | null;
  /** 来源段（若 segmentRepo 已注入且段存在） */
  readonly segment: MemorySegment | null;
  /** 来源段原文（若 conversationRepo 已注入且区间可回读） */
  readonly originalText: string | null;
}

/** 段落总结写入时的来源信息（诉求 A） */
export interface SummarizedSource {
  readonly segmentId: string;
  readonly conversationId: string;
  readonly representativeMessageId?: string;
}

export class MemoryManager {
  private readonly options: MemoryManagerOptions;

  constructor(
    private readonly repo: AgentMemoryRepo,
    options: MemoryManagerOptions = {},
  ) {
    this.options = options;
  }

  /**
   * 构建已有记忆上下文（个人 + 工作），供提取/整理 prompt 使用
   */
  async buildExistingContext(
    agentId: string,
    userId: string,
  ): Promise<ExistingMemoryContext> {
    const workMemories = this.repo.listActive(agentId, userId).map((m) => ({
      content: m.content,
      category: m.category,
    }));

    const personalMemory = this.options.getPersonalMemory
      ? await this.options.getPersonalMemory()
      : undefined;

    return { personalMemory, workMemories };
  }

  /**
   * 一轮 Agent 运行开始前：加载热记忆并拼入 system prompt
   *
   * @param scope 读取作用域。`"user"` 跨 Agent 读取该用户的全部工作记忆，
   *   对应 `AgentDefinition.memory.scope === "user"` 的声明（汇总类 Agent 必须用它，
   *   否则读不到用户在主 Agent 里积累的工作）。
   */
  injectIntoSystemPrompt(
    systemPrompt: string,
    agentId: string,
    userId: string,
    config: HotMemoryConfig = DEFAULT_HOT_MEMORY_CONFIG,
    query?: string,
    scope: MemoryReadScope = "agent",
  ): { readonly updatedPrompt: string; readonly injected: readonly MemoryEntry[] } {
    const injected = this.repo.loadTopMemories(agentId, userId, config, query, scope);
    if (injected.length === 0) {
      // 占位符必须出清：无记忆可注入时替换为空串，防字面量泄漏进模型输入
      return { updatedPrompt: stripMemoryPlaceholder(systemPrompt), injected: [] };
    }
    return {
      updatedPrompt: injectMemories(systemPrompt, injected),
      injected,
    };
  }

  /**
   * 记录本轮注入的效用观测（V47 · 评审 §4.3）。
   *
   * 在 `agent_end` 调用：拿本轮注入快照 + 回复文本，用 bigram 重叠近似判断
   * 「这条记忆有没有被用上」，写 `memory_usage_feedback` 并递增 `utility_count`。
   *
   * **不进打分**：`utility_count` 只入库，`scoreMemory` 仍吃冻结的 `use_count`。
   * 代理噪声未知，先积累数据、抽样验证后再决定是否接线（实施计划 P1-5）。
   *
   * @param entries 本轮注入的记忆（`MemoryIntegration.injectedSnapshot`）
   * @param replyText 本轮最终的助手回复文本
   * @param sessionId 会话标识（无则用实例 id）
   * @param queryLength 触发本轮的用户消息长度（只为特征快照，不落原文）
   * @returns 写入的反馈行数
   */
  recordInjectionOutcome(
    entries: readonly MemoryEntry[],
    replyText: string,
    sessionId: string,
    queryLength: number,
  ): number {
    if (entries.length === 0 || !replyText.trim()) return 0;

    const now = Date.now();
    const outcomes: MemoryInjectionOutcome[] = [];
    for (const e of entries) {
      const { contributionScore, overlap, keywordMatch } = computeContribution(
        e.content,
        replyText,
      );
      const ageDays = (now - new Date(e.created_at).getTime()) / 86_400_000;
      const lastInjectedAt = new Date(e.last_injected_at ?? e.created_at).getTime();
      outcomes.push({
        memoryId: e.id,
        sessionId,
        queryLength,
        wasUsedInResponse: contributionScore > 0,
        contributionScore,
        // MemoryRankingFeatures 的 12 个字段（autonomous/types.ts:415-445）。
        // 当前不可得的填 0 / false —— 宁可留空，也不要编造会污染训练的特征。
        features: {
          semanticSimilarity: overlap,
          keywordMatch,
          queryLength,
          memoryAge: ageDays,
          accessCount: e.exposure_count,
          lastAccessRecency: (now - lastInjectedAt) / 3_600_000,
          memoryLength: e.content.length,
          topicRelevance: overlap,
          userFeedbackScore: 0,
          taskTypeMatch: false,
          avgUtilityScore: e.exposure_count > 0 ? e.utility_count / e.exposure_count : 0,
          retrievalSuccessRate: 0,
        },
      });
    }

    try {
      return this.repo.recordInjectionOutcomes(outcomes, new Date(now));
    } catch (err) {
      // 观测失败不能影响主流程
      console.warn("[MemoryManager] 效用反馈写入失败:", err);
      return 0;
    }
  }

  /** 已积累的效用反馈条数（P1-5 抽样门槛 / 健康检查） */
  countFeedback(): number {
    return this.repo.countFeedback();
  }

  /**
   * 按时间窗全量枚举工作记忆（分页，**不叠加条数上限、不经相关性门控**）。
   *
   * 供日报/周复盘这类汇总任务取「自上次 daily 以来」「最近 7 天」的全量素材：
   * 低 importance 的当日条目同样可达。作用域传 `"user"` 时跨 Agent 读取。
   */
  listByWindow(params: {
    readonly userId: string;
    readonly agentId?: string;
    readonly scope?: MemoryReadScope;
    readonly since: string;
    readonly until?: string;
    readonly field?: "created_at" | "last_used";
    readonly categories?: readonly MemoryCategory[];
    readonly limit?: number;
    readonly offset?: number;
  }): { readonly entries: readonly MemoryEntry[]; readonly total: number; readonly hasMore: boolean } {
    return this.repo.listByWindow(params);
  }

  /**
   * 从用户消息文本中做规则提取并按类别分叉处理：
   * - user/feedback（个人记忆）：触发 onPersonalMemoryExtracted 回调
   * - project/reference/general（工作记忆）：存入 SQLite agent_memories 表
   */
  saveRuleExtractedCandidates(
    userTexts: readonly string[],
    agentId: string,
    userId: string,
  ): number {
    const candidates = extractByRules(userTexts);
    console.log(
      `[MemoryManager] 规则提取候选: ${candidates.length} 条, 分类=[${candidates.map((c) => c.category + ":" + c.content.slice(0, 60)).join(", ")}]`,
    );
    return this.writeCandidatesMerged(candidates, agentId, userId);
  }

  /**
   * 写入候选的统一路径：工作记忆经 mergeCandidates 去重合并写 SQLite；
   * 个人记忆走 onPersonalMemoryExtracted 回调（由宿主 LLM 整理合并）。
   *
   * project 类记忆在写入前做主题级快照压缩：同一项目的多个进度快照只保留最新，
   * 归档旧的（避免 9 条"K8s 配图进度"重复堆积）。
   */
  private writeCandidatesMerged(
    candidates: readonly ExtractedCandidate[],
    agentId: string,
    userId: string,
    source?: SummarizedSource,
  ): number {
    const existing = this.repo.listActive(agentId, userId);

    // 写入侧 schema 门：三道写路径（规则提取 / LLM 提取 / 段落总结）都汇到这里，
    // 故门设在这一层，垃圾不进库，读路径就不必替它买单（评审 §4.2）。
    // 只做形态校验，不做去重——重复项的合并与来源补填交给下面的 mergeCandidates。
    const { accepted, rejected } = validateCandidates(candidates);
    logRejections(rejected, `writeCandidatesMerged(agent=${agentId})`);
    if (accepted.length === 0) return 0;

    const personal: ExtractedCandidate[] = [];
    const ai: ExtractedCandidate[] = [];
    for (const c of accepted) {
      (isPersonalCategory(c.category) ? personal : ai).push(c);
    }

    const { toInsert, toUpdate } = mergeCandidates(existing, ai);

    const writtenIds: string[] = [];
    for (const c of toInsert) {
      const saved = this.repo.saveCandidate({
        agentId,
        userId,
        category: c.category,
        content: c.content,
        importance: c.importance,
        tags: c.tags,
        sourceSegmentId: source?.segmentId,
        sourceMessageId: source?.representativeMessageId,
        projectKey: c.projectKey,
      });
      writtenIds.push(saved.id);
    }
    for (const u of toUpdate) {
      writtenIds.push(u.id);
      this.repo.updateMergedFields(
        u.id,
        u.tags,
        u.importance,
        source
          ? { segmentId: source.segmentId, messageId: source.representativeMessageId }
          : undefined,
      );
    }

    // 取代旧 project 快照（V48）：写完之后做，这样刚写入的新快照能被排除在"被取代"之外
    this.supersedeOldProjectSnapshots(agentId, userId, ai, writtenIds);

    // 个人记忆（user/feedback）不落 SQLite，走宿主的 user_memory Markdown 整理回调。
    // 回调缺失时这些候选**无处可写**，此前是静默消失——「记忆没长出来」这个故障
    // 在日志里完全不可见（评审 P0-5）。至少留一条告警，且不把它计进返回值。
    let personalHandled = 0;
    if (personal.length > 0) {
      const onPersonal = this.options.onPersonalMemoryExtracted;
      if (onPersonal) {
        onPersonal(personal);
        personalHandled = personal.length;
      } else {
        console.warn(
          `[MemoryManager] 丢弃 ${personal.length} 条个人记忆候选：宿主未注入 onPersonalMemoryExtracted 回调` +
            `（agent=${agentId}，内容示例：${personal[0]!.content.slice(0, 40)}）`,
        );
      }
    }

    return toInsert.length + toUpdate.length + personalHandled;
  }

  /**
   * 归档旧的 project 快照：若新候选含某项目主题，归档 existing 中同主题的所有条目。
   * 识别主题：**按候选自带的 `project_key`**（V48），不再用正则猜内容格式。
   */
  private supersedeOldProjectSnapshots(
    agentId: string,
    userId: string,
    newCandidates: readonly ExtractedCandidate[],
    writtenIds: readonly string[],
  ): void {
    const keys = new Set<string>();
    for (const c of newCandidates) {
      if (c.category === "project" && c.projectKey) keys.add(c.projectKey);
    }
    if (keys.size === 0) return;

    for (const key of keys) {
      const n = this.repo.supersedeByProjectKey(agentId, userId, key, writtenIds);
      if (n > 0) {
        console.log(`[MemoryManager] 取代旧 project 快照 ${n} 条: project_key="${key}"`);
      }
    }
  }

  /** 列出某 Agent 下用户的全部活跃记忆 */
  listActive(agentId: string, userId: string): readonly MemoryEntry[] {
    return this.repo.listActive(agentId, userId);
  }

  /** 列出该用户所有 Agent 下的活跃记忆（记忆管理页全量展示） */
  listActiveAllAgents(userId: string): readonly MemoryEntry[] {
    return this.repo.listActiveAllAgents(userId);
  }

  /** 用户手动删除单条记忆 */
  deleteMemory(memoryId: string): void {
    this.repo.removeById(memoryId);
  }

  /**
   * 主动写入单条工作记忆（Agent 经 memory_manage 工具调用）。
   * 仅允许工作记忆类别（project/reference/general）；个人记忆（user/feedback）
   * 走 profile_memory 文档，不在此写入。相同内容幂等（repo 去重）。
   */
  addMemory(params: {
    readonly agentId: string;
    readonly userId: string;
    readonly category: MemoryCategory;
    readonly content: string;
    readonly importance?: number;
    readonly tags?: readonly string[];
  }): MemoryEntry {
    return this.repo.saveCandidate(params);
  }

  /** 归档单条记忆（软删除，可用于"忘记但保留痕迹"） */
  archiveMemory(memoryId: string): void {
    this.repo.archive(memoryId);
  }

  /** 恢复归档记忆 */
  unarchiveMemory(memoryId: string): void {
    this.repo.unarchiveById(memoryId);
  }

  /** 归档某 Agent 下当前用户的全部冷记忆（> 30 天未用且非 personal 类），返回归档条数 */
  archiveColdMemories(agentId: string, userId: string): number {
    return this.repo.archiveCold(agentId, userId, Date.now());
  }

  /**
   * 按关键词搜索记忆（FTS5 + BM25）
   *
   * @param scope `"user"` 跨 Agent 读该用户全部工作记忆，与 `injectIntoSystemPrompt`
   *   的 scope 口径一致（汇总型 Agent 必须用后者，否则检索里搜不到注入里看得到的东西）。
   */
  searchMemories(
    agentId: string,
    userId: string,
    keyword: string,
    limit?: number,
    scope: MemoryReadScope = "agent",
  ): readonly MemoryEntry[] {
    return this.repo.search(agentId, userId, keyword, limit, scope);
  }

  /** 重建 FTS5 派生索引，返回重建后的行数 */
  rebuildMemoryIndex(): number {
    return this.repo.rebuildIndex();
  }

  /** 某 Agent 下当前用户活跃记忆的温度分布（hot/warm/cold） */
  getTemperatureStats(
    agentId: string,
    userId: string,
  ): { readonly hot: number; readonly warm: number; readonly cold: number } {
    return this.repo.countByTemperature(agentId, userId, Date.now());
  }

  /** 回填某来源段产出的所有记忆的宫殿 drawer_id（段原文归档后） */
  setPalaceDrawerIdBySegment(segmentId: string, drawerId: string): void {
    this.repo.setPalaceDrawerIdBySegment(segmentId, drawerId);
  }

  /** 用户手动编辑单条记忆内容 */
  updateMemory(memoryId: string, content: string): void {
    this.repo.updateContentById(memoryId, content);
  }

  /** 清空某 Agent 下当前用户的全部记忆 */
  clearAllForAgent(agentId: string, userId: string): number {
    return this.repo.clearAllForAgent(agentId, userId);
  }

  /**
   * LLM 辅助记忆提取（异步，fire-and-forget）
   *
   * 提取时将历史个人记忆 + 工作记忆一并提供给 LLM 做去重与冲突判断。
   */
  async saveLLMExtractedCandidates(
    recentMessages: readonly { readonly role: string; readonly content: string }[],
    agentId: string,
    userId: string,
  ): Promise<number> {
    const callLLM = this.options.callLLM;
    if (!callLLM) return 0;
    if (recentMessages.length === 0) return 0;

    const existingContext = await this.buildExistingContext(agentId, userId);

    const candidates = await extractByLLM({
      recentMessages,
      existingContext,
      callLLM: (prompt) => callLLM(prompt, { purpose: "memory_extract" }),
    });

    const saved = this.writeCandidatesMerged(candidates, agentId, userId);

    // 提取后无论是否有新候选，检查已有个人记忆是否需要主动整理
    void this.maybeConsolidateExistingPersonalMemory().catch((err) => {
      console.error("[MemoryManager] 主动整理个人记忆失败:", err);
    });

    return saved;
  }

  /**
   * 主动整理已有个人记忆（无新候选时也可触发）
   *
   * 当检测到重复规则、工具冲突、内容过长时，调用 LLM 合并去重。
   */
  async maybeConsolidateExistingPersonalMemory(): Promise<boolean> {
    const { getPersonalMemory, updatePersonalMemory, callLLM } = this.options;
    if (!getPersonalMemory || !updatePersonalMemory || !callLLM) return false;

    const existing = await getPersonalMemory();
    if (!existing?.trim()) return false;

    const check = needsPersonalMemoryConsolidation(existing);
    if (!check.needed) return false;

    console.log(
      `[MemoryManager] 触发个人记忆主动整理: trigger=${check.trigger ?? "unknown"} len=${existing.length}`,
    );

    const result = await consolidateExistingPersonalMemory({
      existingContent: existing,
      callLLM: (prompt) => callLLM(prompt, { purpose: "memory_consolidate" }),
    });

    if (!result.merged || result.content === existing.trim()) return false;

    await updatePersonalMemory(result.content);
    console.log(
      `[MemoryManager] 个人记忆整理完成: trigger=${result.trigger ?? check.trigger} ` +
        `before=${existing.length} after=${result.content.length}`,
    );
    return true;
  }

  /**
   * 写入段落总结产出的候选（去重合并后写入对应层）。
   * 带来源时回填 source_segment_id / source_message_id，支持原文回溯（诉求 A）。
   */
  saveSummarizedCandidates(
    candidates: readonly ExtractedCandidate[],
    agentId: string,
    userId: string,
    source?: SummarizedSource,
  ): number {
    return this.writeCandidatesMerged(candidates, agentId, userId, source);
  }

  /**
   * 记忆来源溯源（诉求 A）：一条工作记忆 → 来源段 → 段原文区间 + 宫殿片段。
   * 段/原文需注入 segmentRepo / conversationRepo，未注入则对应字段为 null。
   */
  getMemoryProvenance(memoryId: string): MemoryProvenance | null {
    const entry = this.repo.findById(memoryId);
    if (!entry) return null;

    const sourceSegmentId = entry.source_segment_id;
    let segment: MemorySegment | null = null;
    let originalText: string | null = null;

    if (sourceSegmentId && this.options.segmentRepo) {
      segment = this.options.segmentRepo.findById(sourceSegmentId);
      if (segment && this.options.conversationRepo) {
        const text = this.options.conversationRepo.loadSegmentText(
          segment.conversationId,
          segment.startMessageId,
          segment.endMessageId ?? segment.startMessageId,
        );
        originalText = text.trim() ? text : null;
      }
    }

    return {
      memoryId,
      sourceSegmentId,
      sourceMessageId: entry.source_message_id,
      palaceDrawerId: entry.palace_drawer_id ?? segment?.palaceDrawerId ?? null,
      segment,
      originalText,
    };
  }
}

// 已删除 `extractProjectTheme()`（2026-09-17，V48）。
//
// 它用正则从自由文本里猜项目主题，是「取代检测器」的旧实现。实测（评审 §2.5.3）：
// 72 条 project 记忆只识别出 13 条（18%）、零重复主题、251 条零归档——根因是正则
// 要求 `项目：XXX` 而真实内容写的是 `XXX：项目当前状态为…`，方向反了。
//
// 修法不是把正则改对：内容格式由模型自由生成，硬编码正则与它注定脱节。
// 现在改由提取时的模型产出结构化 `project_key`（写路径解释），检测器比对它——
// 即 Schema-Grounded Memory 的「less like search, more like a system of record」。
