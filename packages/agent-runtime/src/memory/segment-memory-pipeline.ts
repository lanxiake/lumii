/**
 * SegmentMemoryPipeline — 段落总结记忆管线装配（记忆系统升级阶段① S10）
 *
 * 把 S1-S9 的组件装成一条可用管线，供 AgentInstance 接线：
 *   observe(turn) → SegmentTracker → 段关闭入队 → SummarizationQueue
 *     → 回读区间原文 → LLM 总结 → 解析候选 → MemoryManager 去重合并写入
 *
 * 仅依赖注入的 callLLM（basic tier 由宿主选模型），管线本身与模型无关。
 * 灰度：宿主在 enabled=false 时不创建本管线，完全走旧逻辑。
 */

import type { SegmentRepo } from "../storage/segment-repo.js";
import type { ConversationRepo } from "../storage/conversation-repo.js";
import type { MemoryManager } from "./manager.js";
import type { BoundaryConfig } from "./segmentation.js";
import { SegmentTracker, type ObserveParams } from "./segment-tracker.js";
import { SummarizationQueue } from "./summarization-queue.js";
import { buildSegmentSummaryPrompt, parseCandidatesJson } from "./memory-extractor.js";
import { deterministicDrawerId } from "./content-address.js";

/** 段原文归档元信息（传给宿主 archivePalace 回调） */
export interface ArchivePalaceMeta {
  readonly segmentId: string;
  readonly conversationId: string;
  readonly agentId: string;
  readonly userId: string;
  /** 内容寻址 drawer_id（TS 侧确定性生成，宿主据此做幂等 upsert，P2） */
  readonly drawerId: string;
  /**
   * 宫殿归档位置（wing/room）。由 runtime 计算并传出，确保宿主存储位置与
   * drawerId 的内容寻址输入一致（drawerId = sha256(wing+room+content)）——
   * 宿主不得自行重算，否则 id 与存储位置错位（P2 幂等失效）。
   */
  readonly wing: string;
  readonly room: string;
}

export interface SegmentMemoryPipelineDeps {
  readonly segmentRepo: SegmentRepo;
  readonly conversationRepo: ConversationRepo;
  readonly memoryManager: MemoryManager;
  /** LLM 调用（basic tier 由宿主选模型）；未提供则管线不总结（仅分段，不产出记忆） */
  readonly callLLM?: (prompt: string) => Promise<string>;
  /** 作用域：记忆写入的 agentId / userId */
  readonly agentId: string;
  readonly userId: string;
  /** id 生成器 */
  readonly newId: () => string;
  readonly boundaryConfig?: BoundaryConfig;
  readonly maxRetry?: number;
  readonly minSummaryChars?: number;
  /**
   * 段原文归档进记忆宫殿的回调（诉求 A · 宫殿互引）。
   *
   * runtime 不可 import 插件，故由宿主（持有 mempalace MCP client）注入实现，
   * runtime 只认接口。返回稳定 drawer_id 后回填段与该段产出的记忆。
   * 未提供则跳过宫殿归档（仅做原文回溯，不互引）。
   */
  readonly archivePalace?: (
    text: string,
    meta: ArchivePalaceMeta,
  ) => Promise<{ readonly drawerId?: string }>;
  /** 宫殿归档的 wing/room 生成（默认 wing=会话作用域，room=归档日期） */
  readonly palaceWing?: (conversationId: string, agentId: string) => string;
}

export class SegmentMemoryPipeline {
  private readonly tracker: SegmentTracker;
  private readonly queue: SummarizationQueue;

  constructor(private readonly deps: SegmentMemoryPipelineDeps) {
    this.queue = new SummarizationQueue({
      repo: deps.segmentRepo,
      loadSegmentText: async (seg) =>
        deps.conversationRepo.loadSegmentText(
          seg.conversationId,
          seg.startMessageId,
          seg.endMessageId ?? seg.startMessageId,
        ),
      summarize: async (text, seg) => {
        if (!deps.callLLM) return [];
        console.log(`[SegmentMemory] 开始总结段 id=${seg.id} 原文长度=${text.length}`);
        const existingContext = await deps.memoryManager.buildExistingContext(
          deps.agentId,
          deps.userId,
        );
        const prompt = buildSegmentSummaryPrompt(text, existingContext);
        const response = await deps.callLLM(prompt);
        const candidates = parseCandidatesJson(response);
        console.log(
          `[SegmentMemory] 段 id=${seg.id} 总结产出 ${candidates.length} 条候选: ${candidates.map((c) => `[${c.category}]${c.content.slice(0, 24)}`).join(" | ")}`,
        );
        return candidates;
      },
      onCandidates: async (seg, candidates) => {
        const n = deps.memoryManager.saveSummarizedCandidates(
          candidates,
          deps.agentId,
          deps.userId,
          {
            segmentId: seg.id,
            conversationId: seg.conversationId,
            representativeMessageId: seg.startMessageId,
          },
        );
        console.log(`[SegmentMemory] 段 id=${seg.id} 写入记忆 ${n} 条（去重合并后，已回填来源段）`);

        // 宫殿互引：把段原文归档进记忆宫殿，拿到稳定 drawer_id 回填段与记忆（诉求 A）
        await this.archiveToPalace(seg.id, seg.conversationId);
      },
      maxRetry: deps.maxRetry,
    });

    this.tracker = new SegmentTracker({
      repo: deps.segmentRepo,
      enqueue: (segmentId) => this.queue.enqueue(segmentId),
      newId: deps.newId,
      config: deps.boundaryConfig,
      minSummaryChars: deps.minSummaryChars,
    });
  }

  /** 启动：重启恢复遗留 closed 段 */
  start(): void {
    this.queue.start();
  }

  /** 喂入一轮对话 */
  observe(p: ObserveParams): void {
    this.tracker.observe(p);
  }

  /** 强制关闭某会话 open 段（idle / 会话结束 / 退出 / 压缩前） */
  flush(conversationId: string, reason: string): void {
    this.tracker.flushOpenSegments(conversationId, reason);
  }

  /**
   * 关闭本管线（agentId 作用域）下所有会话的 open 段（app 退出前用）。
   * 仅关闭为 closed（同步，无需等待总结）；下次启动 start() 重启恢复总结。
   */
  flushAll(reason: string): void {
    for (const seg of this.deps.segmentRepo.findAllOpen()) {
      if (seg.agentId !== this.deps.agentId || seg.userId !== this.deps.userId) continue;
      this.tracker.flushOpenSegments(seg.conversationId, reason);
    }
  }

  /** 等待后台总结处理完（优雅退出/测试用） */
  async settle(): Promise<void> {
    await this.queue.settle();
  }

  stop(): void {
    this.queue.stop();
  }

  /**
   * 段原文归档进记忆宫殿并回写 drawer_id（诉求 A · 宫殿互引）。
   *
   * drawer_id 由 TS 侧内容寻址确定性生成（P2）：sha256(wing+room+content)[:16]，
   * 天然防重 + 与阶段二一致。先把 ID 回填到段与该段产出的记忆（不依赖宿主返回），
   * 再调宿主 archivePalace 让宫殿做幂等 upsert。宿主未注入时跳过归档。
   */
  private async archiveToPalace(segmentId: string, conversationId: string): Promise<void> {
    const { archivePalace, conversationRepo, segmentRepo, memoryManager, agentId, userId } =
      this.deps;
    if (!archivePalace) return;

    try {
      const seg = segmentRepo.findById(segmentId);
      if (!seg) return;
      const text = await conversationRepo.loadSegmentText(
        seg.conversationId,
        seg.startMessageId,
        seg.endMessageId ?? seg.startMessageId,
      );
      if (!text.trim()) return;

      const wing = this.deps.palaceWing?.(conversationId, agentId) ?? `${agentId}:${userId}`;
      const room = seg.createdAt.slice(0, 10); // 归档日期
      const drawerId = deterministicDrawerId(wing, room, text);

      // 先回填内容寻址 ID（确定性，不依赖宿主返回）
      segmentRepo.setPalaceDrawerId(seg.id, drawerId);
      memoryManager.setPalaceDrawerIdBySegment(seg.id, drawerId);

      // 再让宿主把原文 upsert 进宫殿（幂等）；返回的 drawerId 若不同则以宿主为准
      const result = await archivePalace(text, {
        segmentId: seg.id,
        conversationId: seg.conversationId,
        agentId,
        userId,
        drawerId,
        wing,
        room,
      });
      if (result.drawerId && result.drawerId !== drawerId) {
        segmentRepo.setPalaceDrawerId(seg.id, result.drawerId);
        memoryManager.setPalaceDrawerIdBySegment(seg.id, result.drawerId);
      }
    } catch (err) {
      // 归档失败不影响记忆写入主流程
      console.warn(
        `[SegmentMemory] 段 ${segmentId} 宫殿归档失败: ${(err as Error).message}`,
      );
    }
  }
}
