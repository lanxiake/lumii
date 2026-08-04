/**
 * Tool Telemetry — 工具调用遥测埋点（主题6 P1-2）
 *
 * 轻量本地埋点：记录每次工具调用的 toolName / durationMs / success / errorType。
 * 默认聚合到内存计数器（供本地诊断），可注入自定义 sink 对接上报系统。
 *
 * 设计原则：
 * - 零外部依赖、同步、不抛错（埋点失败不能影响工具执行）
 * - sink 可替换（默认 no-op，由宿主决定是否写日志/上报）
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

/** 单个工具的聚合统计 */
export interface ToolMetricAggregate {
  toolName: string;
  calls: number;
  successes: number;
  failures: number;
  totalDurationMs: number;
  /** 平均耗时 */
  avgDurationMs: number;
}

/** 遥测 sink：接收每个数据点（同步，不应抛错） */
export type TelemetrySink = (metric: ToolMetric) => void;

/**
 * 工具遥测收集器
 *
 * 内部维护 per-tool 聚合计数，可通过 sink 旁路转发原始数据点。
 */
export class ToolTelemetryCollector {
  private readonly aggregates = new Map<string, ToolMetricAggregate>();

  constructor(private readonly sink?: TelemetrySink) {}

  /** 上报单次工具调用 */
  report(metric: ToolMetric): void {
    let agg = this.aggregates.get(metric.toolName);
    if (!agg) {
      agg = {
        toolName: metric.toolName,
        calls: 0,
        successes: 0,
        failures: 0,
        totalDurationMs: 0,
        avgDurationMs: 0,
      };
      this.aggregates.set(metric.toolName, agg);
    }
    agg.calls++;
    if (metric.success) {
      agg.successes++;
    } else {
      agg.failures++;
    }
    agg.totalDurationMs += metric.durationMs;
    agg.avgDurationMs = Math.round(agg.totalDurationMs / agg.calls);

    // 旁路转发原始数据点（sink 异常不影响聚合）
    if (this.sink) {
      try {
        this.sink(metric);
      } catch {
        // 埋点失败静默忽略
      }
    }
  }

  /** 获取某工具的聚合统计 */
  getAggregate(toolName: string): ToolMetricAggregate | undefined {
    return this.aggregates.get(toolName);
  }

  /** 获取所有聚合统计快照 */
  snapshot(): ToolMetricAggregate[] {
    return Array.from(this.aggregates.values()).map((a) => ({ ...a }));
  }

  /** 清空所有统计 */
  clear(): void {
    this.aggregates.clear();
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
