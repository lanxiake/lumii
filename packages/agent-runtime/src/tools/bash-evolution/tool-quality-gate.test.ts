/**
 * ToolQualityGate 单测 — 含开放式低价值模板拦截
 */

import { describe, expect, it } from "vitest";
import {
  checkToolDraft,
  openTemplateRejectionReason,
} from "./tool-quality-gate.js";
import type { CommandPattern } from "./command-miner.js";
import type { TemplateToolDefinition } from "../template-tool.js";

function pattern(samples: string[]): CommandPattern {
  return {
    pattern: "unused",
    count: samples.length,
    errorCount: 0,
    errorRate: 0,
    avgDurationMs: 100,
    distinctDays: 1,
    samples,
  };
}

function draft(
  overrides: Partial<TemplateToolDefinition> &
    Pick<TemplateToolDefinition, "name" | "commandTemplate">,
): TemplateToolDefinition {
  return {
    description: "一段足够长的工具描述用于通过静态校验",
    parameters: {
      type: "object",
      properties: Object.fromEntries(
        [...overrides.commandTemplate.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g)].map(
          (m) => [m[1]!, { type: "string", description: "param" }],
        ),
      ),
    },
    isReadOnly: false,
    needsPermission: true,
    ...overrides,
  };
}

describe("openTemplateRejectionReason", () => {
  it("拒绝以占位符开头的前置命令注入模板", () => {
    const reason = openTemplateRejectionReason(
      "{{pre_command_chain}}del outputs\\{{output_file}}",
    );
    expect(reason).toMatch(/开头|前置/);
  });

  it("拒绝解释器后几乎全是开放参数的模板", () => {
    const reason = openTemplateRejectionReason(
      "node {{first_node_args}}{{node_chain_1}}{{node_chain_2}}",
    );
    expect(reason).toMatch(/解释器|开放/);
  });

  it("拒绝尾部链式/命令类开放参数", () => {
    const reason = openTemplateRejectionReason(
      "powershell -NoProfile -ExecutionPolicy Bypass -File outputs\\{{scriptFile}}{{postCommand}}",
    );
    expect(reason).toMatch(/尾部|postCommand|开放/);
  });

  it("允许固定骨架明确的参数化工具", () => {
    expect(openTemplateRejectionReason("pnpm --filter {{pkg}} build")).toBeNull();
    expect(openTemplateRejectionReason("git commit -m {{msg}}")).toBeNull();
    expect(
      openTemplateRejectionReason(
        "powershell -NoProfile -ExecutionPolicy Bypass -File outputs\\{{scriptFile}}",
      ),
    ).toBeNull();
  });
});

describe("checkToolDraft 开放模板门", () => {
  it("开放模板计入 errors 且不通过", () => {
    const def = draft({
      name: "run-node-command-chain",
      commandTemplate: "node {{first_node_args}}{{node_chain_1}}{{node_chain_2}}",
    });
    const result = checkToolDraft(def, pattern(["node a.js", "node b.js", "node c.js"]), {
      minReplayRate: 0,
    });
    expect(result.passed).toBe(false);
    expect(result.errors.some((e) => /开放|解释器|工具化价值/.test(e))).toBe(true);
  });
});
