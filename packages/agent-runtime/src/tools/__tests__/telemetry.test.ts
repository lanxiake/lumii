import { describe, it, expect, vi } from "vitest";
import {
  ToolTelemetryCollector,
  reportToolMetrics,
  type ToolMetric,
} from "../telemetry.js";

describe("ToolTelemetryCollector", () => {
  it("sink 收到每个原始数据点", () => {
    const points: ToolMetric[] = [];
    const c = new ToolTelemetryCollector((m) => points.push(m));
    c.report({ toolName: "bash", durationMs: 100, success: true, timestamp: 1 });
    expect(points).toHaveLength(1);
    expect(points[0].toolName).toBe("bash");
  });

  it("sink 抛错不冒泡（埋点失败不能影响工具执行）", () => {
    const c = new ToolTelemetryCollector(() => {
      throw new Error("sink failed");
    });
    expect(() =>
      c.report({ toolName: "bash", durationMs: 100, success: true, timestamp: 1 }),
    ).not.toThrow();
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
