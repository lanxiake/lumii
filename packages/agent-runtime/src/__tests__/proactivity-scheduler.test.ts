/**
 * ProactivityScheduler — cron 间隔解析单测
 */

import { describe, it, expect } from "vitest";
import { parseCronToIntervalMs } from "../agent/proactivity-scheduler.js";

describe("parseCronToIntervalMs", () => {
  it("每 N 分钟", () => {
    expect(parseCronToIntervalMs("*/5 * * * *")).toBe(5 * 60 * 1000);
  });

  it("每 N 小时", () => {
    expect(parseCronToIntervalMs("0 */2 * * *")).toBe(2 * 60 * 60 * 1000);
  });

  it("每天", () => {
    expect(parseCronToIntervalMs("0 0 * * *")).toBe(24 * 60 * 60 * 1000);
  });
});
