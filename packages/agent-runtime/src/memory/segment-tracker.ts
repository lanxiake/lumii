/**
 * SegmentTracker — 对话分段状态机（记忆系统升级阶段① S3）
 *
 * 职责：每轮对话喂入 → 主题边界判定 → 累积进当前 open 段 / 关闭并入队 / 新建段。
 * 段的持久状态在 SegmentRepo（message-id 区间 + 累积 topic 指纹 + 计数）。
 *
 * 边界仅在 user 轮评估（用户驱动话题）；user/assistant 轮都计入段（计数/字符/指纹）。
 * 关闭触发：主题边界 / 容量兜底 / 显式 flush（idle、会话结束、退出、压缩前）。
 *
 * 设计：`.qoder/design/client-agent-runtime/2026-05-30-记忆系统升级-段落总结提取设计.md` §5
 */

import type { SegmentRepo } from "../storage/segment-repo.js";
import {
  tokenizeBigram,
  shouldCloseSegment,
  type BoundaryConfig,
} from "./segmentation.js";

export interface ObserveParams {
  readonly conversationId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly messageId: string;
  readonly ts: number; // ms
  readonly text: string;
  readonly role: "user" | "assistant";
}

export interface SegmentTrackerDeps {
  readonly repo: SegmentRepo;
  /** 段关闭后回调，交给 SummarizationQueue */
  readonly enqueue: (segmentId: string) => void;
  /** id 生成器（可注入便于测试） */
  readonly newId: () => string;
  /** 边界阈值 */
  readonly config?: BoundaryConfig;
  /** 累积 topic 指纹的上限（防膨胀），默认 60 */
  readonly maxTopicTokens?: number;
  /** 段最小字符数：低于此值不入队总结（避免对"嗯/好的"浪费 LLM），默认 15 */
  readonly minSummaryChars?: number;
}

export class SegmentTracker {
  /** 每会话最后一轮时间戳（内存态，用于时间间隔边界；跨进程依赖退出前 flush） */
  private readonly lastTurnTs = new Map<string, number>();

  constructor(private readonly deps: SegmentTrackerDeps) {}

  /** 喂入一轮对话 */
  observe(p: ObserveParams): void {
    const repo = this.deps.repo;
    const open = repo.findOpenByConversation(p.conversationId);

    if (!open) {
      this.createSegment(p);
      this.lastTurnTs.set(p.conversationId, p.ts);
      return;
    }

    // 边界仅在 user 轮评估
    if (p.role === "user") {
      const lastTs = this.lastTurnTs.get(p.conversationId) ?? p.ts;
      const reason = shouldCloseSegment(
        {
          lastTurnTs: lastTs,
          topicTokens: new Set(open.topicTokens),
          turnCount: open.turnCount,
          charCount: open.charCount,
        },
        { ts: p.ts, text: p.text },
        this.deps.config,
      );
      if (reason) {
        // 关闭已有段（end=该段最后已并入的轮），入队，再用本轮新建段
        this.closeAndMaybeEnqueue(open.id, open.endMessageId ?? open.startMessageId, reason, open.charCount);
        this.createSegment(p);
        this.lastTurnTs.set(p.conversationId, p.ts);
        return;
      }
    }

    // 并入当前段
    const newTopic = this.capUnion(open.topicTokens, tokenizeBigram(p.text));
    repo.append(open.id, {
      endMessageId: p.messageId,
      turnCount: open.turnCount + 1,
      charCount: open.charCount + p.text.length,
      topicTokens: newTopic,
    });
    this.lastTurnTs.set(p.conversationId, p.ts);
  }

  /** 强制关闭某会话的 open 段（idle / 会话结束 / 退出 / 压缩前） */
  flushOpenSegments(conversationId: string, reason: string): void {
    const open = this.deps.repo.findOpenByConversation(conversationId);
    if (!open) return;
    this.closeAndMaybeEnqueue(
      open.id,
      open.endMessageId ?? open.startMessageId,
      reason,
      open.charCount,
    );
    this.lastTurnTs.delete(conversationId);
  }

  // ── 内部 ──

  private createSegment(p: ObserveParams): void {
    const tokens = [...tokenizeBigram(p.text)];
    const seg = this.deps.repo.create({
      id: this.deps.newId(),
      conversationId: p.conversationId,
      userId: p.userId,
      agentId: p.agentId,
      startMessageId: p.messageId,
      topicTokens: tokens,
    });
    // create 内 charCount=0；用首轮字符数补一次
    this.deps.repo.append(seg.id, {
      endMessageId: p.messageId,
      turnCount: 1,
      charCount: p.text.length,
      topicTokens: tokens,
    });
    console.log(
      `[SegmentMemory] 新建段 id=${seg.id} conv=${p.conversationId} 首轮="${p.text.slice(0, 30)}"`,
    );
  }

  /** 关闭段；段够长才入队总结，过短直接标记 summarised（跳过，省 LLM） */
  private closeAndMaybeEnqueue(
    segmentId: string,
    endMessageId: string,
    reason: string,
    charCount: number,
  ): void {
    this.deps.repo.close(segmentId, endMessageId, reason);
    const minChars = this.deps.minSummaryChars ?? 15;
    if (charCount >= minChars) {
      console.log(
        `[SegmentMemory] 段关闭→入队总结 id=${segmentId} reason=${reason} chars=${charCount}`,
      );
      this.deps.enqueue(segmentId);
    } else {
      console.log(
        `[SegmentMemory] 段关闭→跳过(过短) id=${segmentId} reason=${reason} chars=${charCount} < ${minChars}`,
      );
      this.deps.repo.markSummarised(segmentId); // 太短，跳过总结
    }
  }

  private capUnion(existing: readonly string[], incoming: Set<string>): string[] {
    const cap = this.deps.maxTopicTokens ?? 60;
    const s = new Set(existing);
    for (const t of incoming) {
      if (s.size >= cap) break;
      s.add(t);
    }
    return [...s];
  }
}
