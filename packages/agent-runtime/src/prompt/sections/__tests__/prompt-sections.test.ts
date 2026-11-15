/**
 * 提示词段元数据与 terse 引导可发现性守卫（P1-T4）
 *
 * 1) PROMPT_SECTIONS 元数据完整性（id 唯一 / terse 段必带 expandVia / 红线段豁免）
 * 2) prompt-guide 段的 guide 正文存在性（PROMPT_GUIDE_SECTIONS 覆盖）
 * 3) terse 渲染文本必须携带展开引导字面量（模型可发现性；文案迭代时的防漂移守卫）
 */

import { describe, expect, it } from "vitest";
import { PROMPT_SECTIONS } from "../../prompt-sections.js";
import { PROMPT_GUIDE_SECTIONS } from "../../section-guides.js";
import { buildClientSystemPromptStructured } from "../../system-prompt-builder.js";
import type { AgentDefinition } from "../../../types/agent-definition.js";
import type { CustomAgentInfo, SkillInfo } from "../../../prompt/system-prompt.types.js";

/** 红线段：安全 / 验证 / 语言 / 完成契约，永久不做 terse 化 */
const RED_LINE_SECTION_IDS = ["safety", "verification", "language", "taskCompletion"] as const;

/** 触发全部 terse 段所需的能力面（P2 扩容时同步扩充本配置） */
const GUARD_TOOLS = [
  "file_read",
  "file_write",
  "message",
  "channel_list",
  "channel_send",
  "weixin_send_guide",
  "browser_screenshot",
  "browser_eval",
  // P2：skills / taskOrchestration / agentCollaboration / wiki / selfLearning
  "skill_search",
  "skill_invoke",
  "spawn_agent",
  "send_message",
  "todo_write",
  "bash",
  "wiki_overview",
  "wiki_search",
  "profile_memory",
  "a2ui_guide",
];

const GUARD_SKILLS: SkillInfo[] = [
  { id: "skill-a", name: "竞品调研", description: "Competitor research workflow", location: "/skills/a/SKILL.md" },
  { id: "skill-b", name: "report-writer", description: "Write structured reports", location: "/skills/b/SKILL.md" },
];

const GUARD_AGENTS: CustomAgentInfo[] = [
  { id: "builtin:explore", name: "探索者", description: "Code exploration specialist" },
  { id: "agent-writer", name: "写手", description: "User-defined writing agent" },
];

const GUARD_DEF: AgentDefinition = {
  id: "guard-assistant",
  name: "守卫助手",
  description: "守卫测试用",
  sourceType: "system",
  version: 1,
  systemPrompt: "You are a guard test assistant.",
  modelTier: "balanced",
  tools: ["*"],
  permissionMode: "default",
  memory: { scope: "user", autoExtract: true },
  isActive: true,
};

const GUARD_BUILD = (promptStyle: "detailed" | "terse" | "minimal") =>
  buildClientSystemPromptStructured({
    agentDefinition: GUARD_DEF,
    toolNames: GUARD_TOOLS,
    cwd: "/workspace",
    runtimeInfo: { channel: "weixin", host: "guard-host - MtBot Windows" },
    skills: GUARD_SKILLS,
    customAgents: GUARD_AGENTS,
    // P3：触发 minimal 专属段（mcp 章节 / bundledCapabilities）
    mcpServerHints: [
      {
        name: "guard-mcp",
        tools: [{ name: "mcp__guard-mcp__ping", description: "Ping the MCP server" }],
      },
    ],
    bundledSkillIds: ["skill-a"],
    promptStyle,
  });

describe("PROMPT_SECTIONS 元数据守卫", () => {
  it("段 ID 无重复", () => {
    const ids = PROMPT_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("terse 段必有 expandVia，且展开方式合法", () => {
    for (const s of PROMPT_SECTIONS) {
      if (s.terse) {
        expect(s.expandVia, s.id).toBeDefined();
        expect(["prompt-guide", "existing-tool", "none"], s.id).toContain(s.expandVia);
      }
    }
  });

  it("expandVia=existing-tool 的段必须声明 expandTool", () => {
    for (const s of PROMPT_SECTIONS) {
      if (s.expandVia === "existing-tool") {
        expect(s.expandTool, s.id).toBeDefined();
        expect(s.expandTool!.length, s.id).toBeGreaterThan(0);
      }
    }
  });

  it("红线段永久不做 terse 化", () => {
    for (const id of RED_LINE_SECTION_IDS) {
      const meta = PROMPT_SECTIONS.find((s) => s.id === id);
      expect(meta, id).toBeDefined();
      expect(meta!.terse, id).toBe(false);
    }
  });

  it("expandVia=prompt-guide 的段：id 必须在 PROMPT_GUIDE_SECTIONS 中", () => {
    const guideIds = new Set(Object.keys(PROMPT_GUIDE_SECTIONS));
    for (const s of PROMPT_SECTIONS) {
      if (s.expandVia === "prompt-guide") {
        expect(guideIds.has(s.id), s.id).toBe(true);
      }
    }
  });

  it("PROMPT_GUIDE_SECTIONS 正文非空且 title 标记 (full)", () => {
    for (const [id, guide] of Object.entries(PROMPT_GUIDE_SECTIONS)) {
      expect(guide.title, id).toContain("(full)");
      expect(guide.body.length, id).toBeGreaterThan(50);
    }
  });
});

describe("流水线归属过滤", () => {
  it("公共流水线恒可见，专属流水线只给归属 Agent", () => {
    const withHints = (agentId: string) =>
      buildClientSystemPromptStructured({
        agentDefinition: { ...GUARD_DEF, id: agentId },
        toolNames: GUARD_TOOLS,
        cwd: "/workspace",
        skills: GUARD_SKILLS,
        customAgents: GUARD_AGENTS,
        promptStyle: "detailed",
        pipelineHints: [
          { id: "shared-one", name: "公共流程", stepCount: 2 },
          { id: "video-only", name: "视频专家专用", stepCount: 3, owner: "video-pro" },
        ],
      }).fullPrompt;

    const asAssistant = withHints("assistant");
    expect(asAssistant).toContain("shared-one");
    expect(asAssistant).not.toContain("video-only");

    const asVideo = withHints("video-pro");
    expect(asVideo).toContain("shared-one");
    expect(asVideo).toContain("video-only");
  });
});

describe("terse 引导可发现性守卫（渲染级）", () => {
  it("每个 prompt-guide 段的 terse 渲染携带对应 prompt_guide(section: \"<id>\") 字面量", () => {
    const { fullPrompt } = GUARD_BUILD("terse");

    for (const s of PROMPT_SECTIONS) {
      if (!s.terse || s.expandVia !== "prompt-guide") continue;
      expect(fullPrompt, s.id).toContain(`prompt_guide(section: "${s.id}")`);
    }
  });

  it("每个 existing-tool 段的 terse 渲染指向其 expandTool 工具链", () => {
    const { fullPrompt } = GUARD_BUILD("terse");

    for (const s of PROMPT_SECTIONS) {
      if (s.expandVia !== "existing-tool") continue;
      expect(fullPrompt, s.id).toContain(s.expandTool!);
    }
  });

  it("detailed 档不出现任何 prompt_guide 引导字面量", () => {
    const { fullPrompt } = GUARD_BUILD("detailed");
    expect(fullPrompt).not.toContain("prompt_guide(section:");
  });
});

describe("极简档守卫（P3）", () => {
  const sectionChars = (r: ReturnType<typeof GUARD_BUILD>, id: string) =>
    r.sectionStats.find((s) => s.id === id)?.chars ?? 0;

  it("元数据 minimal 标记的段：极简渲染与 terse 不同（专属渲染生效）", () => {
    const minimal = GUARD_BUILD("minimal");
    const terse = GUARD_BUILD("terse");
    const flagged = PROMPT_SECTIONS.filter((s) => s.minimal);
    expect(flagged.length).toBeGreaterThan(0);
    for (const s of flagged) {
      expect(sectionChars(minimal, s.id), s.id).toBeGreaterThan(0);
      expect(sectionChars(minimal, s.id), s.id).not.toBe(sectionChars(terse, s.id));
    }
  });

  it("红线段三档一致（detailed / terse / minimal）", () => {
    const detailed = GUARD_BUILD("detailed");
    const terse = GUARD_BUILD("terse");
    const minimal = GUARD_BUILD("minimal");
    for (const id of RED_LINE_SECTION_IDS) {
      expect(sectionChars(terse, id), id).toBe(sectionChars(detailed, id));
      expect(sectionChars(minimal, id), id).toBe(sectionChars(detailed, id));
    }
  });

  it("极简档沿用 terse 引导（prompt-guide 字面量仍可发现）", () => {
    const { fullPrompt } = GUARD_BUILD("minimal");
    for (const s of PROMPT_SECTIONS) {
      if (!s.terse || s.expandVia !== "prompt-guide") continue;
      expect(fullPrompt, s.id).toContain(`prompt_guide(section: "${s.id}")`);
    }
  });
});

describe("子 Agent 提示词收窄", () => {
  it("isSubAgent 时不渲染任务编排段（与 Role Constraint 的 do NOT delegate 一致）", () => {
    const asMain = buildClientSystemPromptStructured({
      agentDefinition: GUARD_DEF,
      toolNames: [...GUARD_TOOLS, "spawn_agent", "todo_write"],
      cwd: "/workspace",
      skills: GUARD_SKILLS,
      customAgents: GUARD_AGENTS,
      promptStyle: "detailed",
    });
    const asSub = buildClientSystemPromptStructured({
      agentDefinition: GUARD_DEF,
      toolNames: [...GUARD_TOOLS, "spawn_agent", "todo_write"],
      cwd: "/workspace",
      skills: GUARD_SKILLS,
      customAgents: GUARD_AGENTS,
      promptStyle: "detailed",
      isSubAgent: true,
    });

    const has = (r: ReturnType<typeof GUARD_BUILD>, id: string) =>
      r.sectionStats.some((s) => s.id === id && s.chars > 0);

    expect(has(asMain, "taskOrchestration")).toBe(true);
    expect(has(asSub, "taskOrchestration")).toBe(false);
    // 角色约束必须出现，否则子 Agent 会以为自己可以继续委派
    expect(asSub.fullPrompt).toContain("Role Constraint");
    expect(asMain.fullPrompt).not.toContain("Role Constraint");
  });
});
