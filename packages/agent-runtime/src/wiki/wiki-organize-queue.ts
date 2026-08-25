/**
 * WikiOrganizeQueue — 整理任务的串行队列 + 重试退避计算
 *
 * 串行范式同 memory/summarization-queue.ts：pending 队列 + current 标志防并发重入，
 * 同一时刻只跑一个整理任务，避免并发写页面/索引冲突。
 *
 * ponytail: 进程内全局锁，不做跨进程协调；多进程并发整理时再升级为 DB 行锁。
 */

const BACKOFF_LADDER_MS: readonly number[] = [
  60_000, // 第 1 次失败后 1 分钟
  5 * 60_000, // 第 2 次后 5 分钟
  30 * 60_000, // 第 3 次后 30 分钟
  2 * 60 * 60_000, // 第 4 次后 2 小时
];

/** 超过退避阶梯的尝试次数即转人工处理态（条目仍保留，不删） */
export const MAX_ORGANIZE_ATTEMPTS = BACKOFF_LADDER_MS.length;

/**
 * 已失败 attemptCount 次后应等待的毫秒数；返回 null 表示不再自动重试，
 * 转人工处理态（对应 wiki_inbox.attempt_count >= 4 时 takeInboxBatch 不再取件）。
 */
export function computeBackoffDelayMs(attemptCount: number): number | null {
  if (attemptCount < 1) return 0;
  if (attemptCount > MAX_ORGANIZE_ATTEMPTS) return null;
  return BACKOFF_LADDER_MS[attemptCount - 1]!;
}

export class WikiOrganizeQueue {
  private readonly pending: Array<() => Promise<void>> = [];
  private current: Promise<void> | null = null;

  /** 入队一个整理任务，立刻触发消费（若空闲） */
  enqueue(task: () => Promise<void>): void {
    this.pending.push(task);
    this.kick();
  }

  /** 等待所有已入队任务完成（测试与优雅退出用） */
  async drain(): Promise<void> {
    while (this.current) await this.current;
  }

  private kick(): void {
    if (this.current) return;
    this.current = this.run().finally(() => {
      this.current = null;
      // run 期间新入队的任务由这里续跑，避免 drain 提前返回
      if (this.pending.length > 0) this.kick();
    });
  }

  private async run(): Promise<void> {
    while (this.pending.length > 0) {
      const task = this.pending.shift()!;
      try {
        await task();
      } catch (err) {
        // 单个任务失败不能拖垮队列——失败语义由任务内部（Organizer）落库记录
        console.warn(`[WikiOrganizeQueue] 整理任务失败: ${(err as Error).message}`);
      }
    }
  }
}
