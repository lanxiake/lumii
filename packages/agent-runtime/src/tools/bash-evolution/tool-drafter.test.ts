/**
 * tool-drafter 与 tool-quality-gate 单测（工具进化 M2）
 */

import { describe, expect, it } from "vitest";
import { draftToolFromPattern, normalizeDraftTemplate } from "./tool-drafter.js";
import {
  checkToolDraft,
  sampleReplayRate,
} from "./tool-quality-gate.js";
import { normalizeCommand, type CommandPattern } from "./command-miner.js";
import type { RefinedPattern } from "./refine-patterns.js";
import type { TemplateToolDefinition } from "../template-tool.js";

const pattern: CommandPattern = {
  pattern: "pnpm --filter {{path}} build",
  count: 12,
  errorCount: 2,
  errorRate: 0.17,
  avgDurationMs: 3000,
  distinctDays: 3,
  samples: [
    "pnpm --filter ./apps/windows build",
    "pnpm --filter ./packages/agent-runtime build",
  ],
};

const refined: RefinedPattern = {
  template: "pnpm --filter {{pkg}} build",
  parameterHints: { pkg: "要构建的 workspace 包路径" },
};

const goodDraftJson = JSON.stringify({
  name: "pnpm-build",
  description: "构建指定的 workspace 包",
  whenToUse: "需要重新构建某个包时",
  whenNotToUse: "只想跑测试时不要用",
  parameters: {
    type: "object",
    properties: { pkg: { type: "string", description: "workspace 包路径" } },
  },
  commandTemplate: "pnpm --filter {{pkg}} build",
  isReadOnly: false,
});

describe("draftToolFromPattern", () => {
  it("解析 LLM 输出的草稿 JSON（容忍 markdown 包裹）", async () => {
    const callLLM = async () => "```json\n" + goodDraftJson + "\n```";
    const draft = await draftToolFromPattern(pattern, refined, { callLLM, existingToolNames: [] });
    expect(draft?.name).toBe("pnpm-build");
    expect(draft?.commandTemplate).toBe("pnpm --filter {{pkg}} build");
  });

  it("LLM 判定破坏性命令（error 字段）返回 null", async () => {
    const callLLM = async () => '{"error": "destructive"}';
    expect(
      await draftToolFromPattern(pattern, refined, { callLLM, existingToolNames: [] }),
    ).toBeNull();
  });

  it("LLM 输出非法/字段缺失返回 null", async () => {
    const bad1 = async () => "无法分析";
    expect(
      await draftToolFromPattern(pattern, refined, { callLLM: bad1, existingToolNames: [] }),
    ).toBeNull();

    const bad2 = async () => '{"name": "x"}';
    expect(
      await draftToolFromPattern(pattern, refined, { callLLM: bad2, existingToolNames: [] }),
    ).toBeNull();
  });

  it("prompt 包含现有工具名（重名检查依据）", async () => {
    let captured = "";
    await draftToolFromPattern(pattern, refined, {
      callLLM: async (p) => {
        captured = p;
        return goodDraftJson;
      },
      existingToolNames: ["bash", "file_read"],
    });
    expect(captured).toContain("bash, file_read");
    expect(captured).toContain("pnpm --filter ./apps/windows build");
  });

  it("单次 prompt 合并语义化模板要求与工具草拟（无需先 refine）", async () => {
    let captured = "";
    await draftToolFromPattern(pattern, null, {
      callLLM: async (p) => {
        captured = p;
        return goodDraftJson;
      },
      existingToolNames: [],
    });
    expect(captured).toContain("语义化");
    expect(captured).toContain("同一次输出");
    expect(captured).not.toContain("已有精归一化模板");
  });

  it("LLM 模板保留引号时草拟结果自动剥离占位符引号", async () => {
    const quoted = JSON.stringify({
      ...JSON.parse(goodDraftJson),
      name: "git-commit",
      commandTemplate: 'git commit -m "{{msg}}"',
      parameters: {
        type: "object",
        properties: { msg: { type: "string", description: "提交信息" } },
      },
    });
    const draft = await draftToolFromPattern(
      { ...pattern, pattern: "git commit -m {{msg}}" },
      null,
      { callLLM: async () => quoted, existingToolNames: [] },
    );
    expect(draft?.commandTemplate).toBe("git commit -m {{msg}}");
  });
});

describe("normalizeDraftTemplate", () => {
  it("剥离双/单引号包裹的占位符，其余位置不动", () => {
    expect(normalizeDraftTemplate('git commit -m "{{msg}}"')).toBe("git commit -m {{msg}}");
    expect(normalizeDraftTemplate("echo '{{text}}'")).toBe("echo {{text}}");
    expect(normalizeDraftTemplate("pnpm --filter {{pkg}} build")).toBe("pnpm --filter {{pkg}} build");
    expect(normalizeDraftTemplate("echo \"literal {{x}} tail\"")).toBe('echo "literal {{x}} tail"');
  });
});

describe("sampleReplayRate", () => {
  const def: TemplateToolDefinition = {
    name: "pnpm-build",
    description: "构建指定的 workspace 包",
    parameters: { type: "object", properties: { pkg: { type: "string" } } },
    commandTemplate: "pnpm --filter {{pkg}} build",
    isReadOnly: false,
    needsPermission: true,
  };

  it("样本归一化后全部匹配时还原率 1", () => {
    expect(sampleReplayRate(def, pattern, normalizeCommand)).toBe(1);
  });

  it("模板覆盖不了样本时还原率降低", () => {
    const mismatched: CommandPattern = {
      ...pattern,
      samples: [
        "pnpm --filter ./apps/windows build",
        "pnpm --filter ./x test", // 与模板结构不符
      ],
    };
    expect(sampleReplayRate(def, mismatched, normalizeCommand)).toBe(0.5);
  });

  it("模板保留引号时按原始样本口径仍可回放（git commit 案例）", () => {
    const quotedDef: TemplateToolDefinition = {
      name: "git-commit",
      description: "提交代码",
      parameters: { type: "object", properties: { message: { type: "string" } } },
      // LLM 基于带引号的原始样本草拟，模板保留了引号
      commandTemplate: 'git commit -m "{{message}}"',
      isReadOnly: false,
      needsPermission: true,
    };
    const commitPattern: CommandPattern = {
      pattern: "git commit -m {{msg}}",
      count: 5,
      errorCount: 0,
      errorRate: 0,
      avgDurationMs: 800,
      distinctDays: 1,
      samples: [
        'git commit -m "feat: 添加设置页工具进化管理UI"',
        'git commit -m "fix: 修复命令归一化路径匹配问题"',
      ],
    };
    expect(sampleReplayRate(quotedDef, commitPattern, normalizeCommand)).toBe(1);
  });
});

describe("checkToolDraft", () => {
  const goodDef: TemplateToolDefinition = {
    name: "pnpm-build",
    description: "构建指定的 workspace 包",
    whenToUse: "需要重新构建某个包时",
    whenNotToUse: "只想跑测试时不要用",
    parameters: {
      type: "object",
      properties: { pkg: { type: "string", description: "workspace 包路径" } },
    },
    commandTemplate: "pnpm --filter {{pkg}} build",
    isReadOnly: false,
    needsPermission: true,
  };

  it("合法草稿通过", () => {
    const result = checkToolDraft(goodDef, pattern, { normalize: normalizeCommand });
    expect(result.passed).toBe(true);
  });

  it("危险命令黑名单拒绝", () => {
    const dangerous: TemplateToolDefinition = {
      ...goodDef,
      name: "wipe-all",
      commandTemplate: "rm -rf {{path}}",
    };
    const result = checkToolDraft(dangerous, pattern, { normalize: normalizeCommand });
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes("黑名单"))).toBe(true);
  });

  it("与内置/已注册工具重名拒绝", () => {
    const clash: TemplateToolDefinition = { ...goodDef, name: "bash" };
    const result1 = checkToolDraft(clash, pattern, { normalize: normalizeCommand });
    expect(result1.errors.some((e) => e.includes("重名"))).toBe(true);

    const clash2: TemplateToolDefinition = { ...goodDef, name: "my-custom" };
    const result2 = checkToolDraft(clash2, pattern, {
      normalize: normalizeCommand,
      registeredNames: ["my-custom"],
    });
    expect(result2.errors.some((e) => e.includes("重名"))).toBe(true);
  });

  it("样本回放率低于阈值拒绝", () => {
    const wrong: TemplateToolDefinition = {
      ...goodDef,
      commandTemplate: "pnpm --filter {{pkg}} test",
    };
    const result = checkToolDraft(wrong, pattern, { normalize: normalizeCommand });
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => e.includes("回放"))).toBe(true);
  });
});
