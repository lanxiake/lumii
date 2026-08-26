/**
 * SubagentBroker — 子 Agent 并发帽、完成队列与摘要投递辅助
 *
 * 纯编排辅助（无 Electron）：由 AgentOrchestrator / bridge 驱动。
 * 不负责实际 prompt/followUp；投递策略见 bridge 侧 idle→prompt / running→followUp。
 */

/** 委派默认配置（写严读宽：调用方缺省走这里） */
export const SUBAGENT_DEFAULTS = {
  maxSpawnDepth: 1,
  maxConcurrentChildren: 5,
  hardMaxConcurrent: 10,
  maxSummaryChars: 24_000,
  staleIdleMs: 180_000,
  staleCheckIntervalMs: 30_000,
} as const;

/** 子 Agent 运行状态 */
export type SubagentRunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "stale";

/** 一次子 Agent 运行记录（broker 内存态） */
export interface SubagentRunRecord {
  readonly childId: string;
  readonly parentId: string;
  readonly name: string;
  readonly mode: "sync" | "async";
  status: SubagentRunStatus;
  readonly startedAt: number;
  lastProgressAt: number;
  outputText: string;
  errorMessage?: string;
  spillPath?: string;
}

/** 投递给父 Agent 的完成载荷 */
export interface SubagentCompletionPayload {
  readonly childId: string;
  readonly parentId: string;
  readonly name: string;
  readonly status: Exclude<SubagentRunStatus, "running">;
  readonly summary: string;
  readonly spillPath?: string;
}

/** registerRun 入参（时间戳可由 broker 填充） */
export interface RegisterSubagentRunInput {
  readonly childId: string;
  readonly parentId: string;
  readonly name: string;
  readonly mode: "sync" | "async";
  readonly startedAt?: number;
}

/**
 * 将并发上限夹到 [1, hardMax]
 */
export function clampConcurrentLimit(
  requested: number | undefined,
  defaults: typeof SUBAGENT_DEFAULTS = SUBAGENT_DEFAULTS,
): number {
  const raw = requested ?? defaults.maxConcurrentChildren;
  return Math.min(defaults.hardMaxConcurrent, Math.max(1, raw));
}

/**
 * 子 Agent 并发与完成队列编排器
 */
export class SubagentBroker {
  private readonly runs = new Map<string, SubagentRunRecord>();
  private readonly completionQueues = new Map<string, SubagentCompletionPayload[]>();
  /** 已 acquire 尚未 registerRun 的预订槽（避免 await 间隙超并发） */
  private readonly pendingSlots = new Map<string, number>();
  private readonly nowFn: () => number;

  /**
   * @param nowFn — 可注入时钟，便于 stale/进度单测
   */
  constructor(nowFn: () => number = () => Date.now()) {
    this.nowFn = nowFn;
  }

  /**
   * 尝试预订父下的一个并发槽：running+pending 已达 limit 则返回 false
   */
  tryAcquireSlot(parentId: string, limit: number): boolean {
    const pending = this.pendingSlots.get(parentId) ?? 0;
    const running = this.countRunning(parentId);
    if (running + pending >= limit) {
      console.log(
        `[SubagentBroker] acquire denied parent=${parentId} running=${running} pending=${pending} limit=${limit}`,
      );
      return false;
    }
    this.pendingSlots.set(parentId, pending + 1);
    console.log(
      `[SubagentBroker] acquire ok parent=${parentId} running=${running} pending=${pending + 1} limit=${limit}`,
    );
    return true;
  }

  /**
   * 释放已预订但尚未 register 的槽（resolve/create 失败路径）
   */
  releasePendingSlot(parentId: string): void {
    const pending = this.pendingSlots.get(parentId) ?? 0;
    if (pending <= 0) return;
    if (pending === 1) this.pendingSlots.delete(parentId);
    else this.pendingSlots.set(parentId, pending - 1);
  }

  /**
   * 释放槽位：移除仍为 running 的记录（创建后立刻失败等路径）
   */
  releaseSlot(childId: string): void {
    const run = this.runs.get(childId);
    if (!run || run.status !== "running") return;
    this.runs.delete(childId);
  }

  /**
   * 登记一次子 Agent 运行（消耗一次 pending，计入 running）
   */
  registerRun(input: RegisterSubagentRunInput): SubagentRunRecord {
    this.releasePendingSlot(input.parentId);
    const now = input.startedAt ?? this.nowFn();
    const record: SubagentRunRecord = {
      childId: input.childId,
      parentId: input.parentId,
      name: input.name,
      mode: input.mode,
      status: "running",
      startedAt: now,
      lastProgressAt: now,
      outputText: "",
    };
    this.runs.set(input.childId, record);
    console.log(
      `[SubagentBroker] registerRun child=${input.childId} parent=${input.parentId} name=${input.name} mode=${input.mode}`,
    );
    return record;
  }

  /**
   * 刷新进度时间戳（message:delta / tool:start 等）
   */
  updateProgress(childId: string, at?: number): void {
    const run = this.runs.get(childId);
    if (!run || run.status !== "running") return;
    run.lastProgressAt = at ?? this.nowFn();
  }

  /**
   * 追加/覆盖输出文本（通常在 message:end 时整段覆盖）
   */
  setOutputText(childId: string, text: string, append = false): void {
    const run = this.runs.get(childId);
    if (!run) return;
    run.outputText = append ? run.outputText + text : text;
  }

  /**
   * 将运行标记为终态并写入输出；running 槽随即释放。
   * 若已是终态则不再覆盖（interrupt/stale 优先）。
   */
  finalizeRun(
    childId: string,
    status: Exclude<SubagentRunStatus, "running">,
    outputText: string,
    errorMessage?: string,
    spillPath?: string,
  ): SubagentRunRecord | undefined {
    const run = this.runs.get(childId);
    if (!run) return undefined;
    if (run.status !== "running") {
      console.log(
        `[SubagentBroker] finalizeRun ignored (already ${run.status}) child=${childId} attempted=${status}`,
      );
      return run;
    }
    run.status = status;
    run.outputText = outputText;
    if (errorMessage !== undefined) {
      run.errorMessage = errorMessage;
    }
    if (spillPath !== undefined) {
      run.spillPath = spillPath;
    }
    run.lastProgressAt = this.nowFn();
    console.log(
      `[SubagentBroker] finalizeRun child=${childId} parent=${run.parentId} status=${status} summaryLen=${outputText.length}${errorMessage ? ` err=${errorMessage.slice(0, 120)}` : ""}`,
    );
    return run;
  }

  /**
   * 从已 finalize 的 run 构建完成载荷
   */
  buildCompletion(childId: string): SubagentCompletionPayload | undefined {
    const run = this.runs.get(childId);
    if (!run || run.status === "running") return undefined;
    return {
      childId: run.childId,
      parentId: run.parentId,
      name: run.name,
      status: run.status,
      summary: run.outputText || run.errorMessage || "",
      spillPath: run.spillPath,
    };
  }

  /**
   * 将完成载荷入队（按 parentId）
   */
  enqueueCompletion(payload: SubagentCompletionPayload): void {
    const queue = this.completionQueues.get(payload.parentId) ?? [];
    queue.push(payload);
    this.completionQueues.set(payload.parentId, queue);
    console.log(
      `[SubagentBroker] enqueueCompletion parent=${payload.parentId} child=${payload.childId} status=${payload.status} queueLen=${queue.length}`,
    );
  }

  /**
   * 取出并清空某父实例的全部待投递完成载荷
   */
  drainCompletions(parentId: string): SubagentCompletionPayload[] {
    const queue = this.completionQueues.get(parentId) ?? [];
    this.completionQueues.delete(parentId);
    if (queue.length > 0) {
      console.log(
        `[SubagentBroker] drainCompletions parent=${parentId} count=${queue.length}`,
      );
    }
    return queue;
  }

  /**
   * 从完成队列移除指定 child（投递成功后避免重复投递）
   */
  removeCompletion(parentId: string, childId: string): boolean {
    const queue = this.completionQueues.get(parentId);
    if (!queue?.length) return false;
    const next = queue.filter((p) => p.childId !== childId);
    const removed = next.length !== queue.length;
    if (next.length === 0) this.completionQueues.delete(parentId);
    else this.completionQueues.set(parentId, next);
    if (removed) {
      console.log(
        `[SubagentBroker] removeCompletion parent=${parentId} child=${childId}`,
      );
    }
    return removed;
  }

  /**
   * 统计某父下仍为 running 的子 Agent 数量
   */
  countRunning(parentId: string): number {
    let n = 0;
    for (const run of this.runs.values()) {
      if (run.parentId === parentId && run.status === "running") n++;
    }
    return n;
  }

  /**
   * 按 childId 查询运行记录
   */
  getRun(childId: string): SubagentRunRecord | undefined {
    return this.runs.get(childId);
  }

  /**
   * 列出某父下全部运行记录（含终态）
   */
  listRunsForParent(parentId: string): readonly SubagentRunRecord[] {
    return [...this.runs.values()].filter((r) => r.parentId === parentId);
  }

  /**
   * 生成投递给父的固定模板文案（便于单测与提示词对齐）
   */
  formatCompletionMessage(payload: SubagentCompletionPayload): string {
    return [
      "[SUBAGENT_COMPLETE]",
      `name: ${payload.name}`,
      `instanceId: ${payload.childId}`,
      `status: ${payload.status}`,
      "summary:",
      payload.summary,
    ].join("\n");
  }

  /**
   * 扫描无进度超时的 async running 子 Agent
   */
  findStaleRuns(
    staleIdleMs: number = SUBAGENT_DEFAULTS.staleIdleMs,
    now: number = this.nowFn(),
  ): SubagentRunRecord[] {
    const stale: SubagentRunRecord[] = [];
    for (const run of this.runs.values()) {
      if (run.status !== "running" || run.mode !== "async") continue;
      if (now - run.lastProgressAt > staleIdleMs) {
        stale.push(run);
      }
    }
    return stale;
  }

  private staleTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * 启动 stale 定时扫描；命中时调用 onStale(childId)
   */
  startStaleMonitor(
    onStale: (childId: string) => void,
    opts?: { staleIdleMs?: number; intervalMs?: number },
  ): void {
    this.stopStaleMonitor();
    const staleIdleMs = opts?.staleIdleMs ?? SUBAGENT_DEFAULTS.staleIdleMs;
    const intervalMs = opts?.intervalMs ?? SUBAGENT_DEFAULTS.staleCheckIntervalMs;
    console.log(
      `[SubagentBroker] startStaleMonitor intervalMs=${intervalMs} staleIdleMs=${staleIdleMs}`,
    );
    this.staleTimer = setInterval(() => {
      const hits = this.findStaleRuns(staleIdleMs);
      for (const run of hits) {
        console.log(
          `[SubagentBroker] stale detected child=${run.childId} parent=${run.parentId} idleMs=${this.nowFn() - run.lastProgressAt}`,
        );
        onStale(run.childId);
      }
    }, intervalMs);
    // 避免测试/短进程挂起
    if (typeof this.staleTimer === "object" && this.staleTimer && "unref" in this.staleTimer) {
      (this.staleTimer as NodeJS.Timeout).unref?.();
    }
  }

  /** 停止 stale 定时器 */
  stopStaleMonitor(): void {
    if (!this.staleTimer) return;
    clearInterval(this.staleTimer);
    this.staleTimer = null;
    console.log("[SubagentBroker] stopStaleMonitor");
  }
}
