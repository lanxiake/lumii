/**
 * guardSubagentSummary 单测：截断、落盘、保留 VERDICT
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  extractLastVerdictLine,
  guardSubagentSummary,
} from "../subagent-summary.js";

describe("extractLastVerdictLine", () => {
  it("取最后一行 VERDICT", () => {
    expect(extractLastVerdictLine("VERDICT: PASS\nx\nVERDICT: FAIL")).toBe("VERDICT: FAIL");
  });

  it("无 VERDICT 返回 undefined", () => {
    expect(extractLastVerdictLine("hello")).toBeUndefined();
  });
});

describe("guardSubagentSummary", () => {
  it("短文本原样返回", () => {
    const r = guardSubagentSummary("short");
    expect(r.summary).toBe("short");
    expect(r.spillPath).toBeUndefined();
  });

  it("超长截断并落盘，末尾保留 VERDICT", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "subagent-summary-"));
    try {
      const body = "A".repeat(100) + "\nVERDICT: PARTIAL";
      const r = guardSubagentSummary(body, { maxChars: 40, cwd });
      expect(r.summary.length).toBeGreaterThan(40); // 含 spill hint 可能略超
      expect(r.summary).toContain("VERDICT: PARTIAL");
      expect(r.spillPath).toBeTruthy();
      expect(existsSync(r.spillPath!)).toBe(true);
      expect(readFileSync(r.spillPath!, "utf8")).toBe(body);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("超长无 VERDICT 时仅截断", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "subagent-summary-"));
    try {
      const body = "B".repeat(80);
      const r = guardSubagentSummary(body, { maxChars: 30, cwd });
      expect(r.summary.startsWith("B".repeat(30))).toBe(true);
      expect(r.spillPath).toBeTruthy();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
