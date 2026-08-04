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
  type ExistingMemoryContext,
} from "./memory-extractor.js";
import {
  consolidateExistingPersonalMemory,
  needsPersonalMemoryConsolidation,
} from "./memory-consolidation.js";
import { injectMemories } from "./memory-injector.js";
import { mergeCandidates } from "./merge.js";
import type { MemoryEntry, MemoryCategory, HotMemoryConfig, ExtractedCandidate } from "./types.js";
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
   */
  injectIntoSystemPrompt(
    systemPrompt: string,
    agentId: string,
    userId: string,
    config: HotMemoryConfig = DEFAULT_HOT_MEMORY_CONFIG,
    query?: string,
  ): { readonly updatedPrompt: string; readonly injected: readonly MemoryEntry[] } {
    const injected = this.repo.loadTopMemories(agentId, userId, config, query);
    if (injected.length === 0) {
      return { updatedPrompt: systemPrompt, injected: [] };
    }
    return {
      updatedPrompt: injectMemories(systemPrompt, injected),
      injected,
    };
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
    const personal: ExtractedCandidate[] = [];
    const ai: ExtractedCandidate[] = [];
    for (const c of candidates) {
      (isPersonalCategory(c.category) ? personal : ai).push(c);
    }

    const existing = this.repo.listActive(agentId, userId);

    // project 快照压缩：归档旧的同主题快照
    const projectCandidates = ai.filter((c) => c.category === "project");
    if (projectCandidates.length > 0) {
      this.archiveOldProjectSnapshots(projectCandidates, existing);
    }

    const { toInsert, toUpdate } = mergeCandidates(existing, ai);

    for (const c of toInsert) {
      this.repo.saveCandidate({
        agentId,
        userId,
        category: c.category,
        content: c.content,
        importance: c.importance,
        tags: c.tags,
        sourceSegmentId: source?.segmentId,
        sourceMessageId: source?.representativeMessageId,
      });
    }
    for (const u of toUpdate) {
      this.repo.updateMergedFields(
        u.id,
        u.tags,
        u.importance,
        source
          ? { segmentId: source.segmentId, messageId: source.representativeMessageId }
          : undefined,
      );
    }

    if (personal.length > 0 && this.options.onPersonalMemoryExtracted) {
      this.options.onPersonalMemoryExtracted(personal);
    }

    return toInsert.length + toUpdate.length + personal.length;
  }

  /**
   * 归档旧的 project 快照：若新候选含某项目主题，归档 existing 中同主题的所有条目。
   * 识别主题：提取 content 中 `项目：XXX` 的 XXX（前 40 字符归一化）。
   */
  private archiveOldProjectSnapshots(
    newProjectCandidates: readonly ExtractedCandidate[],
    existingMemories: readonly MemoryEntry[],
  ): void {
    const newThemes = new Set<string>();
    for (const c of newProjectCandidates) {
      const theme = extractProjectTheme(c.content);
      if (theme) newThemes.add(theme);
    }

    if (newThemes.size === 0) return;

    for (const mem of existingMemories) {
      if (mem.category !== "project") continue;
      const theme = extractProjectTheme(mem.content);
      if (theme && newThemes.has(theme)) {
        console.log(`[MemoryManager] 归档旧 project 快照: ${mem.id} theme="${theme}"`);
        this.repo.archive(mem.id);
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

/**
 * 从 project 类记忆 content 中提取项目主题（归一化键）。
 *
 * 主题识别优先级：
 * 1. 书名号《》「」『』内的标题（最稳定，如「10天架构师速通计划」）
 * 2. `项目：XXX` 中 XXX 的前 16 字符核心前缀
 *
 * 用稳定核心而非整短语，避免「配图与发布推进」「发布推进」等后缀差异
 * 导致同一项目被识别成不同主题。返回 null 表示无法识别。
 */
function extractProjectTheme(content: string): string | null {
  const normalize = (s: string): string =>
    s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");

  // 优先用书名号标题作为主题键
  const titleMatch = content.match(/[《「『]([^》」』]{4,40})[》」』]/);
  if (titleMatch?.[1]) {
    const key = normalize(titleMatch[1]);
    if (key.length >= 4) return key;
  }

  // 回退：项目名前 10 字符核心前缀（短前缀更易让"优化"vs"优化与自动化"等后缀差异归一）
  const projectMatch = content.match(/项目[：:]\s*(.+?)(?:\s*[。.状态]|$)/);
  if (projectMatch?.[1]) {
    const key = normalize(projectMatch[1]).slice(0, 10);
    if (key.length >= 6) return key;
  }

  return null;
}
