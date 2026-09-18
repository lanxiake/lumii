/**
 * Tool Telemetry — 工具调用遥测埋点（主题6 P1-2）
 *
 * 轻量本地埋点：记录每次工具调用的 toolName / durationMs / success / errorType，
 * 通过注入的 sink 旁路转发（宿主据此写日志与审计）。
 *
 * 设计原则：
 * - 零外部依赖、同步、不抛错（埋点失败不能影响工具执行）
 * - sink 可替换（默认 no-op）
 *
 * **2026-09-18 批次 2 删除**：原设计除了 sink，还有一层「聚合到内存计数器
 * （供本地诊断）」——`aggregates` Map 与 `getAggregate()` / `snapshot()` / `clear()`。
 * 那半**无人读**（生产零调用，只有自己的测试在用），而 sink 那半一直在跑
 * （日志里 `[ToolTelemetry]` 持续输出）——即**半套空转**：sink 在发，聚合白算。
 * 已删掉聚合，只留出口。
 */

/** 单次工具调用的遥测数据点 */
export interface ToolMetric {
  /** 工具名 */
  toolName: string;
  /** 执行耗时（ms） */
  durationMs: number;
  /** 是否成功（!isError） */
  success: boolean;
  /** 错误类型（失败时填写，如 error name 或 "tool_error"） */
  errorType?: string;
  /** 时间戳 */
  timestamp: number;
}

/** 遥测 sink：接收每个数据点（同步，不应抛错） */
export type TelemetrySink = (metric: ToolMetric) => void;

/**
 * 工具遥测收集器
 *
 * 只做一件事：把数据点旁路转发给 sink。
 * sink 异常被吞掉——埋点失败不能影响工具执行。
 */
export class ToolTelemetryCollector {
  constructor(private readonly sink?: TelemetrySink) {}

  /** 上报单次工具调用 */
  report(metric: ToolMetric): void {
    if (!this.sink) return;
    try {
      this.sink(metric);
    } catch {
      // 埋点失败静默忽略
    }
  }
}

/**
 * 便捷函数：构造 ToolMetric 并上报到收集器。
 *
 * @param collector - 遥测收集器
 * @param toolName - 工具名
 * @param durationMs - 耗时
 * @param isError - 是否出错
 * @param error - 错误对象（用于提取 errorType）
 */
export function reportToolMetrics(
  collector: ToolTelemetryCollector,
  toolName: string,
  durationMs: number,
  isError: boolean,
  error?: unknown,
): void {
  const errorType = isError
    ? error instanceof Error
      ? error.name
      : error !== undefined
        ? "unknown_error"
        : "tool_error"
    : undefined;
  collector.report({
    toolName,
    durationMs,
    success: !isError,
    errorType,
    timestamp: Date.now(),
  });
}
