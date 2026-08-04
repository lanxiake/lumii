import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";

import { buildActivityIndexAttachment, SessionActivityIndex } from "../session-index.js";
import { createTransformContext } from "../transform-context.js";

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() } as AgentMessage;
}
function assistant(text: string): AgentMessage {
  return { role: "assistant", content: text } as AgentMessage;
}
function buildOverThreshold(): AgentMessage[] {
  const msgs: AgentMessage[] = [];
  for (let i = 0; i < 40; i++) {
    msgs.push(user("x".repeat(500)));
    msgs.push(assistant("y".repeat(500)));
  }
  return msgs;
}

describe("SessionActivityIndex — 会话级文件/技能追踪", () => {
  it("记录 file_read/file_write/file_edit 各一次，各占独立条目", () => {
    const idx = new SessionActivityIndex();
    idx.record("file_read", { filePath: "src/a.ts" });
    idx.record("file_write", { filePath: "src/b.ts" });
    idx.record("file_edit", { filePath: "src/c.ts" });

    const { files, skills } = idx.snapshot();
    expect(skills).toHaveLength(0);
    expect(files).toHaveLength(3);
    const byPath = new Map(files.map((f) => [f.path, f]));
    expect(byPath.get("src/a.ts")).toMatchObject({ lastOp: "read", opCount: 1 });
    expect(byPath.get("src/b.ts")).toMatchObject({ lastOp: "write", opCount: 1 });
    expect(byPath.get("src/c.ts")).toMatchObject({ lastOp: "edit", opCount: 1 });
  });

  it("同一路径先 read 后 edit 合并为一条，lastOp=edit，opCount=2", () => {
    const idx = new SessionActivityIndex();
    idx.record("file_read", { filePath: "src/a.ts" });
    idx.record("file_edit", { filePath: "src/a.ts" });

    const { files } = idx.snapshot();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: "src/a.ts", lastOp: "edit", opCount: 2 });
  });

  it("execute_skill 同名调用两次合并为一条，useCount=2", () => {
    const idx = new SessionActivityIndex();
    idx.record("execute_skill", { id: "issue-manager" });
    idx.record("execute_skill", { id: "issue-manager" });

    const { skills } = idx.snapshot();
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "issue-manager",
      location: "skills/issue-manager/SKILL.md",
      useCount: 2,
    });
  });

  it("未知工具名不产生任何条目", () => {
    const idx = new SessionActivityIndex();
    idx.record("bash", { command: "ls" });
    idx.record("grep", { pattern: "x" });

    const { files, skills } = idx.snapshot();
    expect(files).toHaveLength(0);
    expect(skills).toHaveLength(0);
  });

  it("畸形/缺字段参数不抛错也不产生条目", () => {
    const idx = new SessionActivityIndex();
    expect(() => idx.record("file_read", undefined)).not.toThrow();
    expect(() => idx.record("file_read", null)).not.toThrow();
    expect(() => idx.record("file_read", "not an object")).not.toThrow();
    expect(() => idx.record("file_read", {})).not.toThrow();
    expect(() => idx.record("execute_skill", { id: "" })).not.toThrow();

    const { files, skills } = idx.snapshot();
    expect(files).toHaveLength(0);
    expect(skills).toHaveLength(0);
  });

  it("空索引 snapshot 返回空数组", () => {
    const idx = new SessionActivityIndex();
    expect(idx.snapshot()).toEqual({ files: [], skills: [] });
  });
});

describe("buildActivityIndexAttachment — 附加消息格式化", () => {
  it("文件与技能均为空时返回空数组", () => {
    expect(buildActivityIndexAttachment({ files: [], skills: [] })).toEqual([]);
  });

  it("只有文件时只含 Files touched 段，不含 Skills used", () => {
    const out = buildActivityIndexAttachment({
      files: [{ path: "src/a.ts", lastOp: "edit", opCount: 3 }],
      skills: [],
    });
    expect(out).toHaveLength(1);
    const content = out[0]!.content as string;
    expect(content).toContain("<session_activity_index>");
    expect(content).toContain("Files touched:");
    expect(content).toContain("[edit] src/a.ts (3 次)");
    expect(content).not.toContain("Skills used:");
  });

  it("只有技能时只含 Skills used 段，不含 Files touched", () => {
    const out = buildActivityIndexAttachment({
      files: [],
      skills: [{ name: "issue-manager", location: "skills/issue-manager/SKILL.md", useCount: 2 }],
    });
    const content = out[0]!.content as string;
    expect(content).toContain("Skills used:");
    expect(content).toContain("issue-manager (skills/issue-manager/SKILL.md) — 使用 2 次");
    expect(content).not.toContain("Files touched:");
  });

  it("两者都有时两段都存在，且含强提醒指令文本", () => {
    const out = buildActivityIndexAttachment({
      files: [{ path: "src/a.ts", lastOp: "read", opCount: 1 }],
      skills: [{ name: "issue-manager", location: "skills/issue-manager/SKILL.md", useCount: 1 }],
    });
    const content = out[0]!.content as string;
    expect(content).toContain("Files touched:");
    expect(content).toContain("Skills used:");
    expect(content).toContain("必须先重新读取");
    expect(content).toContain("不要凭记忆执行");
  });

  it("按 opCount / useCount 降序排列", () => {
    const out = buildActivityIndexAttachment({
      files: [
        { path: "src/low.ts", lastOp: "read", opCount: 1 },
        { path: "src/high.ts", lastOp: "edit", opCount: 5 },
      ],
      skills: [
        { name: "low-skill", location: "skills/low-skill/SKILL.md", useCount: 1 },
        { name: "high-skill", location: "skills/high-skill/SKILL.md", useCount: 4 },
      ],
    });
    const content = out[0]!.content as string;
    expect(content.indexOf("src/high.ts")).toBeLessThan(content.indexOf("src/low.ts"));
    expect(content.indexOf("high-skill")).toBeLessThan(content.indexOf("low-skill"));
  });

  it("集成：真实索引经 postCompactRebuild 注入，附件出现在摘要之后、保留消息之前", async () => {
    const idx = new SessionActivityIndex();
    idx.record("file_read", { filePath: "src/a.ts" });
    idx.record("execute_skill", { id: "issue-manager" });

    const transform = createTransformContext({
      contextWindow: 10_000,
      triggerRatio: 0.9,
      keepRecentTurns: 4,
      outputReserveTokens: 500,
      summaryReserveTokens: 500,
      generateSummary: async () => "<summary>ok</summary>",
      postCompactRebuild: {
        buildAttachments: async () => buildActivityIndexAttachment(idx.snapshot()),
      },
    });

    const out = await transform(buildOverThreshold(), undefined);

    const indexMsgIdx = out.findIndex((m) => {
      const c = (m as { content?: unknown }).content;
      return typeof c === "string" && c.includes("<session_activity_index>");
    });
    const summaryMsgIdx = out.findIndex((m) => {
      const c = (m as { content?: unknown }).content;
      return typeof c === "string" && c.includes("This session is being continued");
    });

    expect(indexMsgIdx).toBeGreaterThan(-1);
    expect(summaryMsgIdx).toBeGreaterThan(-1);
    expect(indexMsgIdx).toBeGreaterThan(summaryMsgIdx);

    const content = out[indexMsgIdx]!.content as string;
    expect(content).toContain("src/a.ts");
    expect(content).toContain("issue-manager");
  });
});
