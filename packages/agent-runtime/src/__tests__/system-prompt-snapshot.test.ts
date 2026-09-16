/**
 * 系统提示词快照基线（提示词风格实验 P0-T1）
 *
 * 快照先于一切重构生成并提交：后续「行为零变化」重构（段元数据表 / emit() 包装、
 * 风格接线迁移）必须保持本快照零 diff。若出现计划内升级（迁移映射表声明项），
 * 必须在提交信息中逐条列明。
 *
 * Runtime 段含 `new Date()`，必须冻结系统时间，否则每天红。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { buildClientSystemPromptStructured } from "../prompt/system-prompt-builder.js"
import { PROMPT_SECTIONS } from "../prompt/prompt-sections.js"
import type {
  ActiveTaskInfo,
  CustomAgentInfo,
  McpServerHint,
  SkillInfo,
  UserDeviceInfo,
} from "../prompt/system-prompt.types.js"
import type { AgentDefinition } from "../types/agent-definition.js"

const FROZEN_TIME = new Date("2026-01-01T00:00:00Z")

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(FROZEN_TIME)
})

afterAll(() => {
  vi.useRealTimers()
})

/** 最小 Agent：systemPrompt 为内建简短默认值 → 走 SOUL 内容路径 */
const MINIMAL_DEF: AgentDefinition = {
  id: "test-assistant",
  name: "测试助手",
  description: "测试用",
  sourceType: "system",
  version: 1,
  systemPrompt: "You are MtBot, a helpful AI assistant.",
  modelTier: "balanced",
  tools: ["*"],
  permissionMode: "default",
  memory: { scope: "user", autoExtract: true },
  isActive: true,
}

/** 全能力 Agent：自定义 systemPrompt + personality */
const FULL_DEF: AgentDefinition = {
  ...MINIMAL_DEF,
  id: "full-assistant",
  name: "全能力助手",
  systemPrompt: "You are the all-capable test assistant.",
  personality: "Concise and pragmatic.",
}

/** 子 Agent：memory scope = none（跳过 Memory 段），走子 Agent 角色约束分支 */
const SUBAGENT_DEF: AgentDefinition = {
  ...MINIMAL_DEF,
  id: "sub-coder",
  name: "代码子代理",
  systemPrompt: "You are a coding sub-agent.",
  memory: { scope: "none", autoExtract: false },
}

const SKILLS: readonly SkillInfo[] = [
  {
    id: "weekly-report",
    name: "周报助手",
    description: "生成结构化周报，汇总本周工作项与下周计划。",
    location: "skills/weekly-report/SKILL.md",
    whenToUse: "当用户要求写周报、汇报本周工作时",
    usageCount: 12,
  },
  {
    id: "pdf-export",
    name: "PDF 导出",
    description: "把 Markdown 文档导出为排版良好的 PDF。",
    location: "skills/pdf-export/SKILL.md",
    activationScope: "on_demand",
    executable: true,
    usageCount: 3,
  },
  {
    name: "会议纪要",
    description: "从会议录音或文字稿中整理决议与行动项。",
    location: "skills/meeting-notes/SKILL.md",
    usageCount: 0,
  },
]

const CUSTOM_AGENTS: readonly CustomAgentInfo[] = [
  {
    id: "researcher",
    name: "调研员",
    description: "负责深度调研与资料汇总",
    whenToUse: "需要多来源调研并输出报告时",
    triggerExamples: ["帮我调研一下", "做个竞品分析"],
    category: "research",
    emoji: "🔍",
  },
  {
    id: "editor",
    name: "编辑",
    description: "润色与校对文稿",
  },
]

const USER_DEVICES: readonly UserDeviceInfo[] = [
  {
    nodeId: "node-primary",
    displayName: "我的电脑",
    platform: "win32 10.0.22621",
    isPrimary: true,
    connected: true,
  },
  {
    nodeId: "node-laptop",
    displayName: "笔记本",
    platform: "darwin 24.0.0",
    isPrimary: false,
    connected: false,
  },
]

const ACTIVE_TASKS: readonly ActiveTaskInfo[] = [
  { id: "t1", subject: "整理季度销售数据", status: "in_progress", scope: "session" },
  { id: "t2", subject: "输出分析报告", status: "pending", scope: "session" },
  { id: "t3", subject: "跨会话工单示例", status: "completed", scope: "ticket" },
]

const MCP_HINTS: readonly McpServerHint[] = [
  {
    name: "sqlite",
    instructions: "只读查询本地数据库。",
    tools: [
      { name: "mcp__sqlite__query", description: "执行 SELECT 查询" },
      { name: "mcp__sqlite__list_tables", description: "列出全部表" },
    ],
  },
  {
    name: "empty-server",
    tools: [],
  },
]

describe("系统提示词快照基线（重构对照，勿随意更新快照）", () => {
  it("最小 assistant 配置（SOUL 路径 / 无技能无设备无任务）", () => {
    const result = buildClientSystemPromptStructured({
      agentDefinition: MINIMAL_DEF,
      toolNames: [
        "file_read",
        "file_write",
        "glob",
        "grep",
        "memory_search",
        "memory_read",
        "message",
        "todo_write",
        "task_complete",
      ],
      cwd: "C:/Users/test/.mtbot/workspace",
    })
    expect(result.fullPrompt).toMatchSnapshot()
  })

  it("全能力配置（代码工具 + 技能 + 子 Agent 目录 + 设备 + 活跃任务 + MCP）", () => {
    const result = buildClientSystemPromptStructured({
      agentDefinition: FULL_DEF,
      toolNames: [
        "file_read",
        "file_write",
        "file_edit",
        "glob",
        "grep",
        "bash",
        "memory_search",
        "memory_read",
        "profile_memory",
        "web_search",
        "web_fetch",
        "skill_search",
        "skill_invoke",
        "spawn_agent",
        "send_message",
        "todo_write",
        "task_complete",
        "message",
        "channel_list",
        "channel_send",
        "weixin_send_guide",
        "cron_create",
        "cron_list",
        "cron_delete",
        "browser_navigate",
        "browser_screenshot",
        "browser_click",
        "browser_type",
        "browser_eval",
        "image_generate",
        "speech_generate",
      ],
      cwd: "C:/Users/test/.mtbot/workspace",
      osInfo: "win32 10.0.22621",
      modelId: "claude-sonnet-4-20250514",
      skills: SKILLS,
      customAgents: CUSTOM_AGENTS,
      userDevices: USER_DEVICES,
      activeTasks: ACTIVE_TASKS,
      mcpServerHints: MCP_HINTS,
      bundledSkillIds: ["weekly-report"],
      userMemoryContent: "## 用户偏好\n- 输出语言：中文\n- 工作日 9:00-18:00 在线",
      contextFiles: [{ path: "BOOTSTRAP.md", content: "团队成员：张三、李四。" }],
      runtimeInfo: {
        agentId: "full-assistant",
        host: "MtBot Windows",
        channel: "windows-agent-runtime",
        thinkingLevel: "low",
      },
    })
    expect(result.fullPrompt).toMatchSnapshot()
  })

  it("子 Agent 配置（isSubAgent / memory scope none）", () => {
    const result = buildClientSystemPromptStructured({
      agentDefinition: SUBAGENT_DEF,
      toolNames: ["file_read", "file_write", "file_edit", "glob", "grep", "bash", "task_complete"],
      cwd: "C:/Users/test/.mtbot/workspace",
      osInfo: "win32 10.0.22621",
      isSubAgent: true,
    })
    expect(result.fullPrompt).toMatchSnapshot()
  })

  it("中文渠道场景（weixin 渠道 + messaging 工具 + 技能激活提示）", () => {
    const result = buildClientSystemPromptStructured({
      agentDefinition: MINIMAL_DEF,
      toolNames: ["message", "channel_list", "channel_send", "weixin_send_guide", "file_read", "file_write"],
      cwd: "C:/Users/test/.mtbot/workspace",
      osInfo: "win32 10.0.22621",
      userMemoryContent: "## 用户偏好\n- 常用收件人：文件传输助手",
      runtimeInfo: {
        agentId: "test-assistant",
        host: "MtBot Desktop",
        channel: "weixin",
        thinkingLevel: "low",
      },
      skillActivations: [
        {
          skillName: "周报助手",
          tier: "mandatory",
          reason: "intent_match",
          detail: "用户提到「本周工作总结」",
        },
      ],
    })
    expect(result.fullPrompt).toMatchSnapshot()
  })
})

describe("sectionStats 段级计量（P0-T2）", () => {
  it("段 ID 均在元数据表登记，字符总量与 fullPrompt 相称", () => {
    const { fullPrompt, sectionStats } = buildClientSystemPromptStructured({
      agentDefinition: FULL_DEF,
      toolNames: [
        "file_read",
        "file_write",
        "file_edit",
        "bash",
        "memory_search",
        "message",
        "todo_write",
        "task_complete",
        "cron_create",
        "browser_screenshot",
      ],
      cwd: "C:/Users/test/.mtbot/workspace",
      skills: SKILLS,
      customAgents: CUSTOM_AGENTS,
      activeTasks: ACTIVE_TASKS,
    })

    expect(sectionStats).toBeDefined()
    const stats = sectionStats!
    const known = new Set(PROMPT_SECTIONS.map((s) => s.id))
    for (const s of stats) {
      expect(known.has(s.id)).toBe(true)
    }

    const ids = stats.map((s) => s.id)
    expect(ids).toContain("identity")
    expect(ids).toContain("tooling")
    expect(ids).toContain("memory")
    expect(ids).toContain("workspace")
    expect(ids).toContain("runtime")
    expect(stats.some((s) => s.zone === "static")).toBe(true)
    expect(stats.some((s) => s.zone === "dynamic")).toBe(true)

    // 段字符总量 ≈ fullPrompt 长度（仅差段间换行与 CACHE_BOUNDARY 分隔符）
    const total = stats.reduce((n, s) => n + s.chars, 0)
    expect(total).toBeGreaterThan(0)
    expect(total).toBeLessThanOrEqual(fullPrompt.length)
    expect(total).toBeGreaterThan(fullPrompt.length * 0.9)
  })
})
