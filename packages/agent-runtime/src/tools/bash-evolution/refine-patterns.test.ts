/**
 * refine-patterns 单测 — LLM 辅助归一化
 */

import { describe, expect, it } from "vitest";
import { refinePatternWithLLM } from "./refine-patterns.js";
import type { CommandPattern } from "./command-miner.js";

const pattern: CommandPattern = {
  pattern: "pnpm --filter {{path}} build",
  count: 10,
  errorCount: 2,
  errorRate: 0.2,
  avgDurationMs: 1500,
  distinctDays: 3,
  samples: [
    "pnpm --filter ./apps/windows build",
    "pnpm --filter ./packages/agent-runtime build",
  ],
};

describe("refinePatternWithLLM", () => {
  it("解析 LLM 返回的 JSON（容忍 markdown 代码块包裹）", async () => {
    const callLLM = async () =>
      '```json\n{"template": "pnpm --filter {{pkg}} build", "parameterHints": {"pkg": "要构建的 workspace 包路径"}}\n```';
    const result = await refinePatternWithLLM(pattern, { callLLM });
    expect(result?.template).toBe("pnpm --filter {{pkg}} build");
    expect(result?.parameterHints).toEqual({ pkg: "要构建的 workspace 包路径" });
  });

  it("LLM 返回非法 JSON 时回退 null", async () => {
    const callLLM = async () => "抱歉，我无法分析这些命令。";
    expect(await refinePatternWithLLM(pattern, { callLLM })).toBeNull();
  });

  it("字段缺失/类型错误时回退 null", async () => {
    const callLLM = async () => '{"template": ""}';
    expect(await refinePatternWithLLM(pattern, { callLLM })).toBeNull();

    const callLLM2 = async () => '{"template": "x {{a}}", "parameterHints": {"a": 1}}';
    expect(await refinePatternWithLLM(pattern, { callLLM2 })).toBeNull();
  });

  it("LLM 抛错时回退 null（不影响主链路）", async () => {
    const callLLM = async () => {
      throw new Error("network down");
    };
    expect(await refinePatternWithLLM(pattern, { callLLM })).toBeNull();
  });
});
