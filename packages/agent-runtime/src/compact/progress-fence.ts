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
 * Progress-Aware 双预算 Fence + 原子提交期（Commit Fence）
 */
export class ProgressFence {
  private lastProgressAt = Date.now();
  private readonly startedAt = Date.now();

  /** Phase 3：私有化 commitPhase，只能通过 begin/finish 改 */
  private _commitPhase = false;

  /** Phase 3：revokeCommitAdmission 后设为 true，禁止后续 beginCommit 通过 */
  private _admissionRevoked = false;

  /** Phase 3：cancel_before_commit 赢 race 后置 true */
  private _cancelledBeforeCommit = false;

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

  /** Lock-free 读：是否有提交正在执行中 */
  get commitInFlight(): boolean {
    return this._commitPhase;
  }

  /**
   * 开始原子提交期：调 DB 写入之前必须先调这个。
   * 返回 true = 拿到入场权，可以写 DB；返回 false = 已被 cancel/revoke，不能写。
   */
  beginCommit(): boolean {
    if (this._cancelledBeforeCommit || this._admissionRevoked) {
      return false;
    }
    this._commitPhase = true;
    return true;
  }

  /**
   * 结束原子提交期：DB 写入无论成功/失败（catch 内也必须调）都必须配对调用。
   */
  finishCommit(): void {
    this._commitPhase = false;
  }

  /**
   * 撤销「未来的」提交入场权（当前正在飞的提交不受影响）。
   * Phase2 withProgressTimeout 的任何异常 unwind 路径（finally）必须调这个，
   * 防止 detached worker 之后再偷偷写 DB 分叉会话。
   */
  revokeCommitAdmission(): void {
    this._admissionRevoked = true;
  }

  /** 取消提交（只能在 beginCommit 之前赢 race） */
  cancelBeforeCommit(): boolean {
    if (this._commitPhase) return false;
    this._cancelledBeforeCommit = true;
    return true;
  }

  /** 获取开始时间（供 withProgressTimeout overrun 日志计算） */
  get startTime(): number {
    return this.startedAt;
  }
}

/**
 * 包装 Promise + ProgressFence 的等待循环（对应 Hermes while True L943-L973）。
 * Phase 3: commit-in-flight 时永不中断，30s 分段续等 + WARNING→ERROR 升级日志。
 *
 * @returns 成功时 T；超时放弃返回 null（由上层降级占位）
 */
export async function withProgressTimeout<T>(
  fence: ProgressFence,
  promiseFactory: (fence: ProgressFence) => Promise<T>,
  logger?: { warn: (msg: string) => void; error: (msg: string) => void },
): Promise<T | null> {
  const raceTimeout = (ms: number) =>
    new Promise<"TIMEOUT">((r) => setTimeout(() => r("TIMEOUT"), ms));
  const workerPromise = promiseFactory(fence);

  try {
    while (true) {
      const slice = fence.nextWaitSliceMs();
      if (slice <= 0) {
        // 到 ceiling
        if (!fence.commitInFlight) return null;

        // commit-in-flight：永不中断，分段继续等（30s 一段，WARNING→ERROR 升级）
        let overrunReports = 0;
        const OVERRUN_SLICE_MS = 30_000;
        while (true) {
          const waited = Date.now() - fence.startTime;
          const remaining = fence.totalCeilingMs - waited;
          let waitMs: number;
          if (remaining <= 0) {
            waitMs = OVERRUN_SLICE_MS;
            overrunReports += 1;
            const past = waited - fence.totalCeilingMs;
            const msg = `[CommitFence] SessionDB 提交仍在进行中，已越界 ${(past / 1000).toFixed(1)}s（总等 ${(waited / 1000).toFixed(1)}s，ceiling ${(fence.totalCeilingMs / 1000).toFixed(0)}s）；**永不中断**，继续等下一段 ${(waitMs / 1000).toFixed(0)}s`;
            if (logger) {
              if (overrunReports <= 2) logger.warn(msg);
              else logger.error(msg);
            }
          } else {
            waitMs = Math.min(OVERRUN_SLICE_MS, remaining);
          }
          const r = await Promise.race([workerPromise, raceTimeout(waitMs)]);
          if (r !== "TIMEOUT") return r as T;
        }
      }
      const result = await Promise.race([workerPromise, raceTimeout(slice)]);
      if (result !== "TIMEOUT") {
        return result as T;
      }
      const alive = fence.shouldKeepAlive();
      if (!alive && !fence.commitInFlight) {
        return null;
      }
    }
  } finally {
    fence.revokeCommitAdmission();
  }
}
