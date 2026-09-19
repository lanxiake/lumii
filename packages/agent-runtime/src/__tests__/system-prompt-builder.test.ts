/**
 * 系统提示词构建器回归测试（通用助手改造 Phase 1）
 *
 * P1-T2：详度轴（compact/standard/full）已移除，改全局两态风格（detailed/terse）。
 * - 默认 detailed = 原 standard 基线（吸收 full 专属段：代码细则 / 命名契约 / Disk-Index）
 * - terse 档的红线段（safety / verification / language / taskCompletion / 压缩告知等）不变
 *
 * P3：新增极简档 minimal——terse 之上收敛 MCP 章节 / bundledCapabilities /
 * Workspace / Runtime 客户端上下文四个段（工具定义载荷裁剪在 tools 层，另有专门测试）。
 */

import { describe, expect, it } from "vitest";
import { buildClientSystemPromptStructured } from "../prompt/system-prompt-builder.js";
import { getPromptSectionGuide } from "../prompt/section-guides.js";
import type { AgentDefinition } from "../types/agent-definition.js";

/** 最小 Agent 定义，用于隔离提示词 section 测试 */
const BASE_DEF: AgentDefinition = {
  id: "test-assistant",
  name: "测试助手",
  description: "测试用",
  sourceType: "system",
  version: 1,
  systemPrompt: "You are a test assistant.",
  modelTier: "balanced",
  tools: ["*"],
  permissionMode: "default",
  memory: { scope: "user", autoExtract: true },
  isActive: true,
};

describe("buildClientSystemPromptStructured — capability-driven sections", () => {
  it("detailed 档无代码工具时仍注入工作原则，但不注入代码细则", () => {
    const { fullPrompt } = buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: ["memory_search", "message"],
      cwd: "/workspace",
      promptStyle: "detailed",
    });
    expect(fullPrompt).toContain("## Operating Principles");
    expect(fullPrompt).not.toContain("When writing code:");
    expect(fullPrompt).not.toContain("Write no comments by default");
  });

  it("detailed 档具备代码工具时注入代码细则（原 full 行为升格，迁移映射 #18）", () => {
    const { fullPrompt } = buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: ["file_edit", "file_write", "bash", "memory_search"],
      cwd: "/workspace",
      promptStyle: "detailed",
    });
    expect(fullPrompt).toContain("When writing code:");
    expect(fullPrompt).toContain("Write no comments by default");
  });

  it("detailed 档具备文件工具时注入工具命名契约（原 full 专属，迁移映射 #7）", () => {
    const { fullPrompt } = buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: ["file_read", "file_write", "bash"],
      cwd: "/workspace",
      promptStyle: "detailed",
    });
    expect(fullPrompt).toContain("## Tool Naming Contract");
  });

  it("terse 档不注入工具命名契约（索引化后不再需要）", () => {
    const { fullPrompt } = buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: ["file_read", "file_write", "bash"],
      cwd: "/workspace",
      promptStyle: "terse",
    });
    expect(fullPrompt).not.toContain("## Tool Naming Contract");
  });

  it("默认（不传 style）为 detailed：注入上下文压缩告知", () => {
    const { dynamicPrompt } = buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: ["memory_search", "memory_read"],
      cwd: "/workspace",
    });
    expect(dynamicPrompt).toContain("## Context Compaction");
    expect(dynamicPrompt).toContain("memory_read");
  });

  it("terse 档下上下文压缩告知仍注入（P2 起为一行版）", () => {
    const { dynamicPrompt } = buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: ["memory_search", "memory_read"],
      cwd: "/workspace",
      promptStyle: "terse",
    });
    expect(dynamicPrompt).toContain("## Context Compaction");
    expect(dynamicPrompt).toContain("memory_read");
    // terse 一行版：不再含详细句式的"回查原文"说明
    expect(dynamicPrompt).not.toContain("obtain a `drawer_id`");
  });

  it("keeps recall guidance inside the memory tag", () => {
    const { dynamicPrompt } = buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: ["memory_search", "memory_read", "profile_memory"],
      cwd: "/workspace",
    });
    expect(dynamicPrompt).toContain("<memory>");
    expect(dynamicPrompt).toContain("## Memory");
    expect(dynamicPrompt).toContain("memory_read");
    expect(dynamicPrompt).toContain("</memory>");
  });

  it("does not enumerate low-frequency grouped tools without a guide", () => {
    const { staticPrompt } = buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: ["file_read", "app_screenshot", "app_goto", "screen_record_start", "screen_record_stop"],
    });
    expect(staticPrompt).toContain("`file_read`");
    expect(staticPrompt).not.toContain("`app_screenshot`");
    expect(staticPrompt).not.toContain("`screen_record_start`");
  });
});

describe("首批 5 段 terse/detailed 双渲染（P1-T3）", () => {
  const PILOT_TOOLS = [
    "file_read",
    "file_write",
    "message",
    "channel_list",
    "channel_send",
    "weixin_send_guide",
    "browser_screenshot",
    "browser_eval",
  ];

  const build = (promptStyle: "detailed" | "terse") =>
    buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: PILOT_TOOLS,
      cwd: "/workspace",
      runtimeInfo: { channel: "weixin" },
      promptStyle,
    });

  it("terse 档：5 段均出现展开引导（prompt_guide 字面量 / 既有工具）", () => {
    const { fullPrompt } = build("terse");
    expect(fullPrompt).toContain('prompt_guide(section: "operatingPrinciples")');
    expect(fullPrompt).toContain('prompt_guide(section: "progressiveLoading")');
    expect(fullPrompt).toContain('prompt_guide(section: "fileOutput")');
    expect(fullPrompt).toContain('prompt_guide(section: "browser")');
    // messaging 走既有工具链（weixin_send_guide）
    expect(fullPrompt).toContain("weixin_send_guide");
    expect(fullPrompt).toContain("channel_send");
    // terse 档不注入详细细则
    expect(fullPrompt).not.toContain("### Disk-Index Pattern");
    expect(fullPrompt).not.toContain("## Channel outbound");
  });

  it("terse 档静态段体量显著小于 detailed（索引化生效）", () => {
    const terse = build("terse");
    const detailed = build("detailed");
    expect(terse.staticPrompt.length).toBeLessThan(detailed.staticPrompt.length);
    // detailed 侧保留完整细则
    expect(detailed.fullPrompt).toContain("### Disk-Index Pattern");
    expect(detailed.fullPrompt).toContain("## Channel outbound");
    expect(detailed.fullPrompt).not.toContain("prompt_guide(section:");
  });

  it("terse 档保留操作原则红线句（根因 / 不越界）", () => {
    const { fullPrompt } = build("terse");
    expect(fullPrompt).toContain("stay within scope, fix root causes");
  });
});

describe("terse 极致覆盖（P2）", () => {
  const P2_TOOLS = [
    "file_read",
    "file_write",
    "file_edit",
    "glob",
    "grep",
    "bash",
    "web_search",
    "web_fetch",
    "cron_create",
    "cron_list",
    "cron_delete",
    "cron_guide",
    "skill_search",
    "skill_invoke",
    "memory_search",
    "message",
    "channel_list",
    "channel_send",
  ];

  const build = (promptStyle: "detailed" | "terse") =>
    buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: P2_TOOLS,
      cwd: "/workspace",
      promptStyle,
    });

  const toolingChars = (r: ReturnType<typeof build>) =>
    r.sectionStats.find((s) => s.id === "tooling")?.chars ?? 0;

  it("tooling 折叠：terse 只报组名+数量+引导，不再逐工具列条目", () => {
    const terse = build("terse");
    const detailed = build("detailed");

    expect(terse.fullPrompt).toContain("Groups: File Tools (5), Shell (1)");
    expect(terse.fullPrompt).toContain('prompt_guide(section: "tooling")');
    expect(terse.fullPrompt).not.toContain("- `file_read`:");

    // detailed 侧不变：逐工具摘要 + 组注完整
    expect(detailed.fullPrompt).toContain("- `file_read`:");
    expect(detailed.fullPrompt).toContain("**Default first**");
  });

  it("tooling 段体量：terse 不足 detailed 的 30%", () => {
    const terse = build("terse");
    const detailed = build("detailed");
    const t = toolingChars(terse);
    const d = toolingChars(detailed);
    expect(t).toBeGreaterThan(0);
    expect(d).toBeGreaterThan(1000);
    expect(t / d).toBeLessThan(0.3);
  });

  it("prompt_guide(\"tooling\") 正文与 detailed 渲染同源（含分组与摘要）", () => {
    const guide = getPromptSectionGuide("tooling");
    expect(guide).not.toBeNull();
    expect(guide!.title).toContain("(full)");
    expect(guide!.body).toContain("### File Tools");
    expect(guide!.body).toContain("- `file_read`:");
    expect(guide!.body).toContain("**Default first**");
  });

  it("skills 折叠：terse 仅列 top-12 名称 + 计数，描述不入提示词", () => {
    const skills = Array.from({ length: 30 }, (_, i) => ({
      id: `sk-${i}`,
      name: `skill-${i}`,
      description: `Description for skill ${i}`,
      location: `/skills/skill-${i}/SKILL.md`,
    }));
    const buildWithSkills = (promptStyle: "detailed" | "terse") =>
      buildClientSystemPromptStructured({
        agentDefinition: BASE_DEF,
        toolNames: [...P2_TOOLS, "skill_list"],
        cwd: "/workspace",
        skills,
        promptStyle,
      });
    const terse = buildWithSkills("terse");
    const detailed = buildWithSkills("detailed");

    expect(terse.fullPrompt).toContain("Available skills (30, by usage):");
    expect(terse.fullPrompt).toContain("`skill-0`");
    expect(terse.fullPrompt).toContain("(+18 more via `skill_search`");
    expect(terse.fullPrompt).not.toContain("Description for skill 0");
    expect(detailed.fullPrompt).toContain("Description for skill 0");

    const tc = terse.sectionStats.find((s) => s.id === "skills")?.chars ?? 0;
    const dc = detailed.sectionStats.find((s) => s.id === "skills")?.chars ?? 0;
    expect(dc).toBeGreaterThan(1500);
    expect(tc / dc).toBeLessThan(0.3);
  });

  it("Multi-Agent 协作 terse：Agent 列表保留，委派话术/结果处理移入 guide", () => {
    const agents = [
      { id: "builtin:explore", name: "探索者", description: "Code exploration specialist" },
      { id: "agent-writer", name: "写手", description: "User-defined writing agent" },
    ];
    const buildWithAgents = (promptStyle: "detailed" | "terse") =>
      buildClientSystemPromptStructured({
        agentDefinition: BASE_DEF,
        toolNames: [...P2_TOOLS, "spawn_agent", "send_message"],
        cwd: "/workspace",
        customAgents: agents,
        promptStyle,
      });
    const terse = buildWithAgents("terse");
    const detailed = buildWithAgents("detailed");

    expect(terse.fullPrompt).toContain("builtin:explore");
    expect(terse.fullPrompt).toMatch(/agent-writer/);
    expect(terse.fullPrompt).toContain('prompt_guide(section: "agentCollaboration")');
    expect(terse.fullPrompt).not.toContain("Writing a Delegation Prompt");
    expect(detailed.fullPrompt).toContain("Writing a Delegation Prompt");
    expect(detailed.fullPrompt).toContain("Handling Results");
  });

  it("Task Orchestration terse：要点行 + guide；detailed 保留分节细则", () => {
    const buildOrch = (promptStyle: "detailed" | "terse") =>
      buildClientSystemPromptStructured({
        agentDefinition: BASE_DEF,
        toolNames: [...P2_TOOLS, "todo_write"],
        cwd: "/workspace",
        promptStyle,
      });
    const terse = buildOrch("terse");
    const detailed = buildOrch("detailed");

    expect(terse.fullPrompt).toContain("batch_create");
    expect(terse.fullPrompt).toContain('prompt_guide(section: "taskOrchestration")');
    expect(terse.fullPrompt).not.toContain("### When to Create a Task List");
    expect(detailed.fullPrompt).toContain("### When to Create a Task List");

    const tc = terse.sectionStats.find((s) => s.id === "taskOrchestration")?.chars ?? 0;
    const dc = detailed.sectionStats.find((s) => s.id === "taskOrchestration")?.chars ?? 0;
    expect(tc / dc).toBeLessThan(0.5);
  });

  it("wiki terse：读序 + CLI 指引 + guide；folder import 流程移出提示词", () => {
    const buildWiki = (promptStyle: "detailed" | "terse") =>
      buildClientSystemPromptStructured({
        agentDefinition: BASE_DEF,
        toolNames: [...P2_TOOLS, "bash", "wiki_overview"],
        cwd: "/workspace",
        promptStyle,
      });
    const terse = buildWiki("terse");
    const detailed = buildWiki("detailed");

    expect(terse.fullPrompt).toContain('prompt_guide(section: "wiki")');
    expect(terse.fullPrompt).toContain("wiki_overview");
    expect(terse.fullPrompt).not.toContain("folder scan");
    expect(detailed.fullPrompt).toContain("folder scan");
  });

  it("selfLearning terse：一行版（feedback 记忆 / SOUL 更新）", () => {
    const buildSl = (promptStyle: "detailed" | "terse") =>
      buildClientSystemPromptStructured({
        agentDefinition: BASE_DEF,
        toolNames: [...P2_TOOLS, "profile_memory", "system_prompt"],
        cwd: "/workspace",
        promptStyle,
      });
    const terse = buildSl("terse");
    const detailed = buildSl("detailed");

    expect(terse.fullPrompt).toContain("## Self-Improvement");
    expect(terse.fullPrompt).toContain("profile_memory");
    expect(terse.fullPrompt).not.toContain("When the user corrects you, save the reusable lesson");
    expect(detailed.fullPrompt).toContain("When the user corrects you, save the reusable lesson");

    const tc = terse.sectionStats.find((s) => s.id === "selfLearning")?.chars ?? 0;
    const dc = detailed.sectionStats.find((s) => s.id === "selfLearning")?.chars ?? 0;
    expect(tc / dc).toBeLessThan(0.6);
  });
});

describe("极简档 minimal（P3）", () => {
  const P3_TOOLS = [
    "file_read",
    "file_write",
    "bash",
    "skill_search",
    "skill_list",
    "memory_search",
    "message",
    "todo_write",
    "task_complete",
  ];

  const MCP_HINTS = [
    {
      name: "sqlite",
      instructions: "只读查询本地数据库。",
      tools: [
        { name: "mcp__sqlite__query", description: "执行 SELECT 查询" },
        { name: "mcp__sqlite__list_tables", description: "列出全部表" },
      ],
    },
  ];

  const SKILLS = [
    {
      id: "weekly-report",
      name: "周报助手",
      description: "生成结构化周报，汇总本周工作项与下周计划。",
      location: "/skills/weekly-report/SKILL.md",
    },
  ];

  const build = (
    promptStyle: "detailed" | "terse" | "minimal",
    extra: Record<string, unknown> = {},
  ) =>
    buildClientSystemPromptStructured({
      agentDefinition: BASE_DEF,
      toolNames: P3_TOOLS,
      cwd: "/workspace",
      runtimeInfo: { channel: "windows-agent-runtime", host: "test-host - MtBot Windows" },
      promptStyle,
      ...extra,
    });

  const sectionChars = (r: ReturnType<typeof build>, id: string) =>
    r.sectionStats.find((s) => s.id === id)?.chars ?? 0;

  it("MCP 章节：只列 server 名 + 工具名，instructions 保留、逐工具描述移出", () => {
    const minimal = build("minimal", { mcpServerHints: MCP_HINTS });
    const terse = build("terse", { mcpServerHints: MCP_HINTS });

    expect(minimal.fullPrompt).toContain("### sqlite");
    expect(minimal.fullPrompt).toContain("只读查询本地数据库。");
    expect(minimal.fullPrompt).toContain("`mcp__sqlite__query`");
    expect(minimal.fullPrompt).not.toContain("执行 SELECT 查询");
    // terse 档保持逐工具描述（P2 未覆盖 mcp 段）
    expect(terse.fullPrompt).toContain("执行 SELECT 查询");
    expect(sectionChars(minimal, "mcp")).toBeLessThan(sectionChars(terse, "mcp"));
  });

  it("bundledCapabilities：只列技能名，描述移出", () => {
    const minimal = build("minimal", { skills: SKILLS, bundledSkillIds: ["weekly-report"] });
    const terse = build("terse", { skills: SKILLS, bundledSkillIds: ["weekly-report"] });

    expect(minimal.fullPrompt).toContain("- 周报助手");
    expect(minimal.fullPrompt).not.toContain("生成结构化周报");
    expect(terse.fullPrompt).toContain("生成结构化周报");
  });

  it("Workspace 紧凑版：硬约束保留、段内字符数明显小于 terse", () => {
    const minimal = build("minimal");
    const terse = build("terse");

    expect(minimal.fullPrompt).toContain("Never write into the workspace root");
    expect(minimal.fullPrompt).toContain("`outputs/<project-or-task>/`");
    expect(minimal.fullPrompt).toContain("`temp/<task>/`");
    expect(minimal.fullPrompt).toContain("under 50 characters");
    expect(sectionChars(minimal, "workspace")).toBeGreaterThan(0);
    expect(sectionChars(minimal, "workspace")).toBeLessThan(sectionChars(terse, "workspace") * 0.5);
  });

  it("Runtime 客户端上下文：极简一行（terse 保留整段）", () => {
    const minimal = build("minimal");
    const terse = build("terse");

    expect(minimal.fullPrompt).toContain("MtBot Windows desktop client (Electron)");
    expect(minimal.fullPrompt).not.toContain("You are running inside the **MtBot Windows desktop client**");
    expect(terse.fullPrompt).toContain("You are running inside the **MtBot Windows desktop client**");
    expect(sectionChars(minimal, "runtime")).toBeLessThan(sectionChars(terse, "runtime"));
  });

  it("红线段与 terse 逐字节同量（safety / verification / language / taskCompletion）", () => {
    const minimal = build("minimal");
    const terse = build("terse");
    for (const id of ["safety", "verification", "language", "taskCompletion"]) {
      expect(sectionChars(minimal, id), id).toBe(sectionChars(terse, id));
      expect(sectionChars(minimal, id), id).toBeGreaterThan(0);
    }
  });

  it("terse 共用段与 terse 渲染同量（skills / tooling / taskOrchestration）", () => {
    const minimal = build("minimal", { skills: SKILLS });
    const terse = build("terse", { skills: SKILLS });
    for (const id of ["skills", "tooling", "taskOrchestration", "selfLearning"]) {
      expect(sectionChars(minimal, id), id).toBe(sectionChars(terse, id));
      expect(sectionChars(minimal, id), id).toBeGreaterThan(0);
    }
  });
});

/**
 * personality 与工具能力一致性
 *
 * 回归背景（2026-09-19）：assistant 的 personality 写死了「you MUST delegate ... use
 * `spawn_agent`」，而子 Agent / 自主进化受限实例继承同一 personality 却没有该工具
 * （bridge-lifecycle.createChildInstance、bridge.ts 的受限定义都摘掉了 spawn_agent）。
 * 结果子 Agent 照指令调用 spawn_agent → "Tool spawn_agent not found"，任务白跑一轮。
 */
describe("buildClientSystemPromptStructured — personality 委派口径与工具对齐", () => {
  /** 继承 assistant personality（含委派指令）的受限实例 */
  const RESTRICTED_DEF: AgentDefinition = {
    ...BASE_DEF,
    personality: "=== Role ===\nFor non-trivial work, delegate with `spawn_agent`.",
  };

  const OVERRIDE_HEADER = "## Tool Availability (overrides the instructions above)";

  it("personality 提到 spawn_agent 但工具缺失 → 追加更正说明", () => {
    const { staticPrompt } = buildClientSystemPromptStructured({
      agentDefinition: RESTRICTED_DEF,
      toolNames: ["file_read", "file_write", "bash"],
      cwd: "/workspace",
    });
    expect(staticPrompt).toContain(OVERRIDE_HEADER);
    expect(staticPrompt).toContain("Ignore any earlier instruction to delegate");
  });

  it("工具齐全时不追加（主 Agent 照常委派）", () => {
    const { staticPrompt } = buildClientSystemPromptStructured({
      agentDefinition: RESTRICTED_DEF,
      toolNames: ["spawn_agent", "file_read"],
      cwd: "/workspace",
    });
    expect(staticPrompt).not.toContain(OVERRIDE_HEADER);
  });

  it("personality 未提委派 → 不追加（不给无委派能力的 Agent 灌口水）", () => {
    const { staticPrompt } = buildClientSystemPromptStructured({
      agentDefinition: { ...BASE_DEF, personality: "Concise and pragmatic." },
      toolNames: ["file_read"],
      cwd: "/workspace",
    });
    expect(staticPrompt).not.toContain("## Tool Availability");
  });
});
