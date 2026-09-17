/**
 * SummarizationQueue — 段落总结的异步后台队列（记忆系统升级阶段① S4）
 *
 * 职责：串行消费 closed 段 → 回读原文 → 总结 → 候选回调 → 标记 summarised。
 * - 串行：同一时刻只处理一个段，避免并发写记忆冲突
 * - 重启恢复：start() 经注入的 listPending 扫描本作用域遗留 closed 段续处理（进程退出不丢）
 * - 重试：失败 incrementRetry，超上限放弃（标 summarised），不阻塞
 * - 总结逻辑（prompt/LLM/解析）通过注入的 summarize 解耦，队列本身与模型无关
 *
 * 设计：`.qoder/design/client-agent-runtime/2026-05-30-记忆系统升级-段落总结提取设计.md` §7
 */

import type { SegmentRepo, MemorySegment } from "../storage/segment-repo.js";
import type { ExtractedCandidate } from "./types.js";

export interface SummarizationQueueDeps {
  readonly repo: SegmentRepo;
  /**
   * 列出待恢复的 closed 段（start() 用）。
   * 由调用方（SegmentMemoryPipeline）按自身 agent+user 作用域实现——
   * 队列不自行决定扫描范围，避免一条 pipeline 总结到别的 agent 的段。
   */
  readonly listPending: (limit: number) => readonly MemorySegment[];
  /** 按 message-id 区间回读段落原文（拼成可总结文本）；返回空串表示无内容 */
  readonly loadSegmentText: (seg: MemorySegment) => Promise<string>;
  /** 对整段原文总结产出候选（内部调 LLM + 解析）；失败抛错 */
  readonly summarize: (text: string, seg: MemorySegment) => Promise<readonly ExtractedCandidate[]>;
  /** 候选产出回调（去重合并 + 写入在此，S5） */
  readonly onCandidates: (
    seg: MemorySegment,
    candidates: readonly ExtractedCandidate[],
  ) => void | Promise<void>;
  /** 失败重试上限，默认 2 */
  readonly maxRetry?: number;
  /** start() 扫描 closed 段的批量上限，默认 100 */
  readonly recoverLimit?: number;
}

/** 队列运行统计（可观测性：段落管线是工作记忆的唯一产出源，断供必须看得见） */
export interface SummarizationStats {
  /** 成功走完 summarize 的段数（含产出为空的情况） */
  readonly summarised: number;
  /** summarize 返回空候选的次数——正常（段里没有值得记的），但持续为 0 产出时可据此定位 */
  readonly emptyCandidates: number;
  /** 无原文可总结而跳过的段数 */
  readonly noText: number;
  /** 发生异常的次数（含重试） */
  readonly failed: number;
  /** 超过重试上限被放弃的段数——**这是"记忆不再增长"的关键信号** */
  readonly abandoned: number;
  /** 最近一次失败的时间与原因（无失败为 null） */
  readonly lastError: { readonly at: string; readonly message: string } | null;
}

export class SummarizationQueue {
  private readonly pending = new Set<string>();
  private current: Promise<void> | null = null;
  private stopped = false;
  private stats = {
    summarised: 0,
    emptyCandidates: 0,
    noText: 0,
    failed: 0,
    abandoned: 0,
    lastError: null as { at: string; message: string } | null,
  };

  constructor(private readonly deps: SummarizationQueueDeps) {}

  /**
   * 运行统计快照。
   *
   * 之所以要给计数而不是只留日志：段落管线是工作记忆的**唯一产出源**，
   * 它静默停摆时表现为「记忆不再增长」——这种故障没有报错、没有崩溃，
   * 只有计数能把它暴露出来（评审 §6 R3）。
   */
  getStats(): SummarizationStats {
    return { ...this.stats };
  }

  /** 入队一个段（段关闭后调用） */
  enqueue(segmentId: string): void {
    this.pending.add(segmentId);
    this.kick();
  }

  /** 启动：扫描本作用域遗留 closed 段续处理（重启恢复） */
  start(): void {
    this.stopped = false;
    const limit = this.deps.recoverLimit ?? 100;
    const pending = this.deps.listPending(limit);
    if (pending.length > 0) {
      console.log(`[SegmentMemory] 重启恢复：发现 ${pending.length} 个待总结 closed 段`);
    }
    for (const seg of pending) this.pending.add(seg.id);
    this.kick();
  }

  /** 停止（不再启动新一轮 drain；当前段处理完即止） */
  stop(): void {
    this.stopped = true;
  }

  /** 等待当前队列处理完（测试/优雅退出用） */
  async settle(): Promise<void> {
    while (this.current) await this.current;
  }

  // ── 内部 ──

  private kick(): void {
    if (this.current || this.stopped) return;
    this.current = this.drain().finally(() => {
      this.current = null;
    });
  }

  private async drain(): Promise<void> {
    while (!this.stopped && this.pending.size > 0) {
      const id = this.pending.values().next().value as string;
      this.pending.delete(id);
      await this.process(id);
    }
  }

  private async process(segmentId: string): Promise<void> {
    const repo = this.deps.repo;
    const seg = repo.findById(segmentId);
    // 只处理 closed 段（已 summarised / 不存在 / 仍 open 都跳过）
    if (!seg || seg.status !== "closed") return;

    try {
      const text = await this.deps.loadSegmentText(seg);
      if (!text.trim()) {
        this.stats.noText++;
        repo.markSummarised(seg.id); // 无原文可总结，跳过
        return;
      }
      const candidates = await this.deps.summarize(text, seg);
      if (candidates.length > 0) {
        await this.deps.onCandidates(seg, candidates);
      } else {
        this.stats.emptyCandidates++;
      }
      this.stats.summarised++;
      repo.markSummarised(seg.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.stats.failed++;
      this.stats.lastError = { at: new Date().toISOString(), message };
      const maxRetry = this.deps.maxRetry ?? 2;
      const retry = repo.incrementRetry(seg.id);
      if (retry > maxRetry) {
        // 超上限放弃：标 summarised 避免无限重试（记日志）
        this.stats.abandoned++;
        repo.markSummarised(seg.id);
        console.warn(
          `[SummarizationQueue] 段 ${seg.id} 总结失败 ${retry} 次，放弃: ${message}` +
            `（累计放弃 ${this.stats.abandoned} 段 / 失败 ${this.stats.failed} 次）`,
        );
      } else {
        // 留 closed，下次 start() 重启恢复时再试（不立即重入避免快速重试循环）
        console.warn(`[SummarizationQueue] 段 ${seg.id} 总结失败（第 ${retry} 次），稍后重试: ${message}`);
      }
    }
  }
}
