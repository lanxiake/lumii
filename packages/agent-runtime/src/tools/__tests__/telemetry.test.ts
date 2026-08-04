import { describe, it, expect, vi } from "vitest";
import {
  ToolTelemetryCollector,
  reportToolMetrics,
  type ToolMetric,
} from "../telemetry.js";

describe("ToolTelemetryCollector", () => {
  it("聚合单工具的调用次数与成功/失败", () => {
    const c = new ToolTelemetryCollector();
    c.report({ toolName: "bash", durationMs: 100, success: true, timestamp: 1 });
    c.report({ toolName: "bash", durationMs: 200, success: false, errorType: "Error", timestamp: 2 });

    const agg = c.getAggregate("bash");
    expect(agg).toBeDefined();
    expect(agg?.calls).toBe(2);
    expect(agg?.successes).toBe(1);
    expect(agg?.failures).toBe(1);
    expect(agg?.totalDurationMs).toBe(300);
    expect(agg?.avgDurationMs).toBe(150);
  });

  it("多工具独立聚合", () => {
    const c = new ToolTelemetryCollector();
    c.report({ toolName: "bash", durationMs: 100, success: true, timestamp: 1 });
    c.report({ toolName: "file_read", durationMs: 50, success: true, timestamp: 2 });

    expect(c.snapshot()).toHaveLength(2);
    expect(c.getAggregate("file_read")?.avgDurationMs).toBe(50);
  });

  it("sink 收到每个原始数据点", () => {
    const points: ToolMetric[] = [];
    const c = new ToolTelemetryCollector((m) => points.push(m));
    c.report({ toolName: "bash", durationMs: 100, success: true, timestamp: 1 });
    expect(points).toHaveLength(1);
    expect(points[0].toolName).toBe("bash");
  });

  it("sink 抛错不影响聚合", () => {
    const c = new ToolTelemetryCollector(() => {
      throw new Error("sink failed");
    });
    expect(() =>
      c.report({ toolName: "bash", durationMs: 100, success: true, timestamp: 1 }),
    ).not.toThrow();
    expect(c.getAggregate("bash")?.calls).toBe(1);
  });

  it("clear 清空所有统计", () => {
    const c = new ToolTelemetryCollector();
    c.report({ toolName: "bash", durationMs: 100, success: true, timestamp: 1 });
    c.clear();
    expect(c.snapshot()).toHaveLength(0);
  });
});

describe("reportToolMetrics", () => {
  it("成功：success=true, 无 errorType", () => {
    const sink = vi.fn();
    const c = new ToolTelemetryCollector(sink);
    reportToolMetrics(c, "bash", 120, false);
    const m = sink.mock.calls[0][0] as ToolMetric;
    expect(m.success).toBe(true);
    expect(m.errorType).toBeUndefined();
  });

  it("Error 实例：errorType = error.name", () => {
    const sink = vi.fn();
    const c = new ToolTelemetryCollector(sink);
    reportToolMetrics(c, "bash", 120, true, new TypeError("boom"));
    const m = sink.mock.calls[0][0] as ToolMetric;
    expect(m.success).toBe(false);
    expect(m.errorType).toBe("TypeError");
  });

  it("isError=true 但无 error 对象：errorType = tool_error", () => {
    const sink = vi.fn();
    const c = new ToolTelemetryCollector(sink);
    reportToolMetrics(c, "bash", 120, true);
    const m = sink.mock.calls[0][0] as ToolMetric;
    expect(m.errorType).toBe("tool_error");
  });

  it("非 Error 错误对象：errorType = unknown_error", () => {
    const sink = vi.fn();
    const c = new ToolTelemetryCollector(sink);
    reportToolMetrics(c, "bash", 120, true, "string error");
    const m = sink.mock.calls[0][0] as ToolMetric;
    expect(m.errorType).toBe("unknown_error");
  });
});
