/**
 * ProactivityScheduler — Agent 主动触发调度器
 *
 * 根据 AgentDefinition.proactivity 配置，在满足条件时
 * 自动触发 Agent 发起对话。
 *
 * 支持三种触发类型：
 * - cron: 定时触发（基于 cron 表达式）
 * - event: 事件触发（监听外部事件名称）
 * - condition: 条件触发（预留，暂不实现）
 *
 * 设计依据: .qoder/design/client-agent-runtime/03-Agent定义与生命周期.md §1.2
 */

import type { ProactivityConfig, ProactivityTrigger } from "../types/agent-definition.js";

/** 触发回调：当条件满足时调用，传入触发器配置 */
export type TriggerCallback = (trigger: ProactivityTrigger) => void | Promise<void>;

/** 单个 Cron 定时任务 */
interface CronJob {
  readonly trigger: ProactivityTrigger;
  readonly intervalHandle: ReturnType<typeof setInterval>;
}

/**
 * Proactivity 调度器
 *
 * 管理一个 Agent 的所有主动触发器。
 *
 * 使用方式:
 * ```typescript
 * const scheduler = new ProactivityScheduler(definition.proactivity, (trigger) => {
 *   agent.prompt(trigger.prompt)
 * })
 * scheduler.start()
 * // ...
 * scheduler.stop()
 * ```
 */
export class ProactivityScheduler {
  private readonly config: ProactivityConfig | undefined;
  private readonly callback: TriggerCallback;
  private readonly cronJobs: CronJob[] = [];
  private readonly eventHandlers = new Map<string, () => void>();
  private running = false;

  constructor(config: ProactivityConfig | undefined, callback: TriggerCallback) {
    this.config = config;
    this.callback = callback;
  }

  /** 启动所有触发器 */
  start(): void {
    if (this.running) return;
    if (!this.config?.triggers.length) return;

    this.running = true;

    for (const trigger of this.config.triggers) {
      switch (trigger.type) {
        case "cron":
          this.startCronTrigger(trigger);
          break;
        case "event":
          this.registerEventTrigger(trigger);
          break;
        case "condition":
          console.log(`[ProactivityScheduler] condition 类型触发器暂未实现: ${trigger.condition}`);
          break;
      }
    }

    console.log(`[ProactivityScheduler] 已启动 ${this.config.triggers.length} 个触发器`);
  }

  /** 停止所有触发器 */
  stop(): void {
    if (!this.running) return;

    // 停止所有 cron 任务
    for (const job of this.cronJobs) {
      clearInterval(job.intervalHandle);
    }
    this.cronJobs.length = 0;

    // 清除事件处理器引用
    this.eventHandlers.clear();

    this.running = false;
    console.log("[ProactivityScheduler] 所有触发器已停止");
  }

  /**
   * 手动触发指定事件
   *
   * 外部代码在事件发生时调用此方法，匹配的 event 触发器将被激活。
   */
  fireEvent(eventName: string): void {
    if (!this.running) return;
    const handler = this.eventHandlers.get(eventName);
    if (handler) {
      handler();
    }
  }

  /** 是否有触发器配置 */
  get hasTriggers(): boolean {
    return (this.config?.triggers.length ?? 0) > 0;
  }

  /** 是否正在运行 */
  get isRunning(): boolean {
    return this.running;
  }

  // ==================== 内部方法 ====================

  /**
   * 启动 Cron 定时触发器
   *
   * 使用简化的 cron 解析：支持分钟级间隔（如 "* /5 * * * *" = 每5分钟）。
   * 对于更复杂的 cron 表达式，建议在网关侧使用 croner 库。
   */
  private startCronTrigger(trigger: ProactivityTrigger): void {
    if (!trigger.cronExpression) {
      console.log("[ProactivityScheduler] cron 触发器缺少 cronExpression，跳过");
      return;
    }

    const intervalMs = parseCronToIntervalMs(trigger.cronExpression);
    if (!intervalMs) {
      console.log(`[ProactivityScheduler] 无法解析 cron 表达式: ${trigger.cronExpression}，跳过`);
      return;
    }

    const intervalHandle = setInterval(() => {
      if (!this.running) return;
      console.log(`[ProactivityScheduler] cron 触发: ${trigger.cronExpression}`);
      void this.callback(trigger);
    }, intervalMs);

    this.cronJobs.push({ trigger, intervalHandle });
    console.log(
      `[ProactivityScheduler] cron 任务已注册: ${trigger.cronExpression} (${intervalMs}ms 间隔)`,
    );
  }

  /** 注册事件触发器 */
  private registerEventTrigger(trigger: ProactivityTrigger): void {
    if (!trigger.eventName) {
      console.log("[ProactivityScheduler] event 触发器缺少 eventName，跳过");
      return;
    }

    const handler = () => {
      console.log(`[ProactivityScheduler] event 触发: ${trigger.eventName}`);
      void this.callback(trigger);
    };

    this.eventHandlers.set(trigger.eventName, handler);
    console.log(`[ProactivityScheduler] event 监听已注册: ${trigger.eventName}`);
  }
}

// ==================== 辅助函数 ====================

/**
 * 简化的 cron 表达式解析器
 *
 * 支持常见模式：
 * - "* /N * * * *" → 每 N 分钟
 * - "0 * /N * * *" → 每 N 小时
 * - "0 0 * * *"    → 每天 0:00（24 小时间隔）
 *
 * 对于不可解析的表达式返回 null。
 */
/** 导出供单测与宿主校验 cron 间隔解析 */
export function parseCronToIntervalMs(expression: string): number | null {
  const parts = expression.trim().split(/\s+/);

  // 每 N 分钟: "*/N * * * *" 或 "0/N * * * *"
  if (parts.length >= 5 && /^\*\/(\d+)$/.test(parts[0]!)) {
    const minutes = parseInt(RegExp.$1, 10);
    if (minutes > 0) return minutes * 60 * 1000;
  }

  // 每 N 小时: "0 */N * * *"
  if (parts.length >= 5 && parts[0] === "0" && /^\*\/(\d+)$/.test(parts[1]!)) {
    const hours = parseInt(RegExp.$1, 10);
    if (hours > 0) return hours * 60 * 60 * 1000;
  }

  // 每天: "0 0 * * *"
  if (parts.length >= 5 && parts[0] === "0" && parts[1] === "0" && parts[2] === "*") {
    return 24 * 60 * 60 * 1000;
  }

  // 每小时: "0 * * * *"
  if (parts.length >= 5 && parts[0] === "0" && parts[1] === "*") {
    return 60 * 60 * 1000;
  }

  return null;
}
