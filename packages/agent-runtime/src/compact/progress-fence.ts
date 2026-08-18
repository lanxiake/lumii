/**
 * progress-fence —— Progress-Aware 双预算 + Commit Fence 骨架
 *
 * 移植 Hermes CompressionCommitFence + run_compress_context_with_progress_timeout。
 * Phase 2: 搭骨架（touchProgress + 双预算）
 * Phase 3: 扩展 commitPhase（beginCommit/finishCommit）
 *
 * 两个预算（两者取 min 才等）：
 *   - idleTimeoutMs：距上次"看到进度"多久才算挂了（默认 120s）—— 慢模型流式 token 到达时 touchProgress()，自动续命
 *   - totalCeilingMs：无论如何绝对最多等多久（默认 600s = 10min）——防死等
 */

/**
 * Progress-Aware 双预算 Fence
 */
export class ProgressFence {
  private lastProgressAt = Date.now();
  private readonly startedAt = Date.now();
  /** Phase 3 用：beginCommit() 后置 true，永不中断外层循环；Phase 2 恒 false */
  private commitPhase = false;

  constructor(
    readonly idleTimeoutMs: number = 120_000, // 120s 无进度判死
    readonly totalCeilingMs: number = 600_000, // 10min 绝对封顶
  ) {}

  /** 流式摘要每收到一个新 token 调用一次（单调前进；touch ≠ 死亡计时重置） */
  touchProgress(): void {
    this.lastProgressAt = Date.now();
  }

  /** 距上次进度多少秒（供日志打印） */
  secondsSinceProgress(): number {
    return (Date.now() - this.lastProgressAt) / 1000;
  }

  /**
   * 计算下一次等待的时间片 = min(剩余 idle 预算, 剩余 ceiling 预算)
   * 对应 Hermes wait_slice = min(max(idle - since_progress, 0.005), remaining_ceiling)
   */
  nextWaitSliceMs(): number {
    const waitedMs = Date.now() - this.startedAt;
    const remainingCeiling = this.totalCeilingMs - waitedMs;
    const remainingIdle = this.idleTimeoutMs - (Date.now() - this.lastProgressAt);
    if (remainingCeiling <= 0) return 0;
    // 最小等 5ms，避免 1ms busy loop
    return Math.max(5, Math.min(remainingIdle, remainingCeiling));
  }

  /** 是否还有命（两个预算都没耗尽）→ true = 继续续命循环 */
  shouldKeepAlive(): boolean {
    const waitedMs = Date.now() - this.startedAt;
    const sinceProgressMs = Date.now() - this.lastProgressAt;
    return sinceProgressMs < this.idleTimeoutMs && waitedMs < this.totalCeilingMs;
  }
}

/**
 * 包装 Promise + ProgressFence 的等待循环（对应 Hermes while True L943-L973）。
 * 使用方：runSummaryStage 把原来的 Promise.race(timeout) 替换成这个。
 *
 * @returns 成功时 T；超时放弃返回 null（由上层降级占位）
 */
export async function withProgressTimeout<T>(
  fence: ProgressFence,
  promiseFactory: (fence: ProgressFence) => Promise<T>,
): Promise<T | null> {
  const raceTimeout = (ms: number) =>
    new Promise<"TIMEOUT">((r) => setTimeout(() => r("TIMEOUT"), ms));
  const workerPromise = promiseFactory(fence);

  while (true) {
    const slice = fence.nextWaitSliceMs();
    if (slice <= 0) {
      // 到 ceiling：commitPhase=false → 超时放弃；commitPhase=true → 永不中断（Phase3 处理）
      if (!fence["commitPhase"]) return null;
      // commit phase：分段继续等（每 30s 一段，打 WARNING→ERROR 日志；Phase 3 实现升级日志）
      continue;
    }
    const result = await Promise.race([workerPromise, raceTimeout(slice)]);
    if (result !== "TIMEOUT") {
      return result as T; // 真拿到了
    }
    // 时间片用完了 → 检查是否能续命
    const alive = fence.shouldKeepAlive();
    if (!alive && !fence["commitPhase"]) {
      return null; // 真挂了
    }
    // alive=true → 继续循环（Hermes L962-L972：打印 still streaming 日志后 continue）
  }
}
