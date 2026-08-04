/**
 * post-compact —— 压缩后处理：可观测诊断 + 上下文重建钩子骨架
 *
 * B4 落地：
 * - RecompactionTracker：维护"上次压缩轮次"状态，计算 isRecompaction / turnsSincePreviousCompact
 * - PostCompactRebuild：压缩后上下文重建钩子接口（骨架，不注入时零回归）
 *
 * 借鉴 claude-code buildPostCompactMessages 的"压缩后重建上下文"思想，但本期只搭骨架，
 * 具体附件重建（工作区文件快照 / 活跃 plan 回填）留后续主题实现。
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

/**
 * 再压缩诊断追踪器
 *
 * 记录上次压缩发生时的"全局压缩计数"，用于判断本次是否为连续压缩链中的再压缩
 * （上次压缩后很快又触发，通常意味着单轮产出过大或上下文压力持续）。
 */
export class RecompactionTracker {
  /** 已发生的压缩总次数 */
  private compactionCount = 0;
  /** 上次压缩时的“处理轮次”计数（由外部 turn 累加传入） */
  private lastCompactTurn = -1;

  /**
   * 在一次实际压缩发生时调用，返回本次的诊断信息。
   *
   * @param currentTurn 当前处理轮次（调用方维护的单调计数；无则传 compactionCount）
   */
  record(currentTurn: number): { isRecompaction: boolean; turnsSincePreviousCompact: number } {
    const isRecompaction = this.compactionCount > 0;
    const turnsSincePreviousCompact = this.lastCompactTurn < 0 ? -1 : currentTurn - this.lastCompactTurn;
    this.compactionCount += 1;
    this.lastCompactTurn = currentTurn;
    return { isRecompaction, turnsSincePreviousCompact };
  }
}

/** 压缩后上下文重建的运行时上下文 */
export interface PostCompactContext {
  /** 被压缩掉的旧消息段（供重建器决定回填哪些文件/状态） */
  oldMessages: AgentMessage[];
  /** 压缩后保留的最近消息段 */
  recentMessages: AgentMessage[];
  /** 本次压缩采用的策略 */
  strategy: "micro" | "summary" | "hard-trim" | "none";
}

/**
 * 压缩后上下文重建钩子（B4 骨架，可选注入）。
 *
 * 借鉴 claude-code：压缩后并行重建关键上下文（最近读过的文件快照、活跃 plan、skill delta）。
 * 本期仅定义接口，宿主（host-kit）可注入实现。不注入时压缩行为与现状完全一致（零回归）。
 */
export interface PostCompactRebuild {
  /**
   * 返回压缩后需并入的附加消息（如工作区文件快照、活跃任务清单）。
   * 这些消息会插在摘要之后、保留消息之前（由 transform-context 编排）。
   */
  buildAttachments?(ctx: PostCompactContext): Promise<AgentMessage[]>;
}
