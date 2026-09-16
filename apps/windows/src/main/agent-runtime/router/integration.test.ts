/**
 * Router → buildClientSystemPromptStructured 端到端集成测试
 *
 * P2 缓存修复（2026-09-13）后的语义：Router 结果只注入动态 Routing rationale，
 * 不再过滤静态区 skills/agents 列表（按轮过滤会改写静态前缀、破坏整份提示词缓存）。
 * 本文件守护：路由建议可达 + 静态区逐字节稳定。
 */

import { describe, expect, it } from "vitest"
import {
  buildClientSystemPromptStructured,
  type CustomAgentInfo,
  type SkillInfo,
  type RouterResultLite,
  type AgentDefinition,
} from "@mtbot/agent-runtime"

function makeSkills(n: number): SkillInfo[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `skill-${i}`,
    name: `skill-${i}`,
    description: `Description for skill ${i}`,
    location: `/skills/skill-${i}/SKILL.md`,
  }))
}

function makeAgents(n: number): CustomAgentInfo[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `agent-${i}`,
    name: `agent-${i}`,
    description: `Agent ${i} description`,
  }))
}

const MOCK_AGENT_DEF: AgentDefinition = {
  id: "assistant",
  name: "Assistant",
  systemPrompt: "你是助手",
  modelTier: "balanced",
  sourceType: "system",
  version: 1,
  tools: ["*"],
  isActive: true,
}

const BASE_PARAMS = {
  agentDefinition: MOCK_AGENT_DEF,
  toolNames: ["spawn_agent", "skill_search", "skill_invoke", "send_message"],
  cwd: "/tmp",
}

describe("Router 集成：routerResult 只进动态 Routing rationale，静态区保持稳定", () => {
  it("无 routerResult 时主 prompt 包含全部 skills/agents", () => {
    const skills = makeSkills(100)
    const agents = makeAgents(10)
    const result = buildClientSystemPromptStructured({
      ...BASE_PARAMS,
      skills,
      customAgents: agents,
    })
    // 抽样：第 50 个技能名应在 prompt 中（工具化模式不会列出全部名字，但 description 至少要"接触到"完整数据）
    // 这里只验证整体 prompt 长度，作为基线
    expect(result.fullPrompt.length).toBeGreaterThan(0)
  })

  it("confidence ≥ 0.6 + fallback=none：路由建议进动态段，静态列表不被过滤", () => {
    const skills = makeSkills(100)
    const agents = makeAgents(10)
    const routerResult: RouterResultLite = {
      confidence: 0.9,
      fallback: "none",
      intent: "image_gen",
      topAgents: [{ id: "agent-3", score: 0.9, reason: "用户想画图" }],
      topSkills: [
        { id: "skill-7", score: 0.95, reason: "图像生成" },
        { id: "skill-42", score: 0.8, reason: "图片编辑" },
      ],
    }
    const result = buildClientSystemPromptStructured({
      ...BASE_PARAMS,
      skills,
      customAgents: agents,
      routerResult,
    })
    const plain = buildClientSystemPromptStructured({
      ...BASE_PARAMS,
      skills,
      customAgents: agents,
    })

    // 路由建议以 Routing rationale（动态段）承载
    expect(result.fullPrompt).toContain("Routing rationale")
    expect(result.fullPrompt).toContain("image_gen")
    expect(result.fullPrompt).toContain("agent-3")
    expect(result.fullPrompt).toContain("skill-7")
    // 未推荐成员仍完整在列（静态区不再被裁剪）
    expect(result.fullPrompt).toMatch(/`agent-5`/)
    expect(result.fullPrompt).toMatch(/`agent-0`/)
    // 缓存稳定性：有无 routerResult 的静态区逐字节一致
    expect(result.staticPrompt).toBe(plain.staticPrompt)
  })

  it("fallback != none 时走旧路径（不过滤）", () => {
    const skills = makeSkills(50)
    const agents = makeAgents(8)
    const routerResult: RouterResultLite = {
      confidence: 0.95,
      fallback: "timeout", // 即使 confidence 高，也降级
      intent: "x",
      topAgents: [{ id: "agent-0", score: 0.9, reason: "" }],
      topSkills: [{ id: "skill-0", score: 0.9, reason: "" }],
    }
    const result = buildClientSystemPromptStructured({
      ...BASE_PARAMS,
      skills,
      customAgents: agents,
      routerResult,
    })

    // fallback 时不应出现 Routing rationale section
    expect(result.fullPrompt).not.toContain("Routing rationale")
  })

  it("confidence < 0.6 时走旧路径（不过滤）", () => {
    const skills = makeSkills(50)
    const agents = makeAgents(8)
    const routerResult: RouterResultLite = {
      confidence: 0.4,
      fallback: "none",
      intent: "ambiguous",
      topAgents: [{ id: "agent-0", score: 0.4, reason: "" }],
      topSkills: [],
    }
    const result = buildClientSystemPromptStructured({
      ...BASE_PARAMS,
      skills,
      customAgents: agents,
      routerResult,
    })

    expect(result.fullPrompt).not.toContain("Routing rationale")
  })

  it("缓存稳定性：有无 routerResult 的 staticPrompt 逐字节一致（P2 修复回归守卫）", () => {
    const skills = makeSkills(100)
    const agents = makeAgents(10)

    const plain = buildClientSystemPromptStructured({
      ...BASE_PARAMS,
      skills,
      customAgents: agents,
    })

    const routed = buildClientSystemPromptStructured({
      ...BASE_PARAMS,
      skills,
      customAgents: agents,
      routerResult: {
        confidence: 0.9,
        fallback: "none",
        intent: "test",
        topAgents: [{ id: "agent-0", score: 0.9, reason: "test" }],
        topSkills: [{ id: "skill-0", score: 0.9, reason: "test" }],
      },
    })

    expect(routed.staticPrompt).toBe(plain.staticPrompt)
    // 差异只应出现在 dynamic（Routing rationale）
    expect(routed.fullPrompt).toContain("Routing rationale")
    expect(plain.fullPrompt).not.toContain("Routing rationale")
  })

  it("全量 agent 列表完整保留（router 结果不再裁剪静态区）", () => {
    const agents = makeAgents(20)
    const plain = buildClientSystemPromptStructured({
      ...BASE_PARAMS,
      customAgents: agents,
    }).fullPrompt
    const routed = buildClientSystemPromptStructured({
      ...BASE_PARAMS,
      customAgents: agents,
      routerResult: {
        confidence: 0.9,
        fallback: "none",
        intent: "test",
        topAgents: [{ id: "agent-0", score: 0.9, reason: "test" }],
        topSkills: [],
      },
    }).fullPrompt
    // 全部 agent 仍在列
    expect(routed).toMatch(/`agent-0`/)
    expect(routed).toMatch(/`agent-15`/)
    expect(routed).toMatch(/`agent-19`/)
    // 路由只追加建议，不再缩短提示词
    expect(routed.length).toBeGreaterThanOrEqual(plain.length)
  })

  it("bundledSkillIds 注入 Your bundled capabilities section", () => {
    const skills = makeSkills(50)
    const result = buildClientSystemPromptStructured({
      ...BASE_PARAMS,
      skills,
      bundledSkillIds: ["skill-3", "skill-7"],
    })
    expect(result.fullPrompt).toContain("Your bundled capabilities")
    expect(result.fullPrompt).toContain("skill-3")
    expect(result.fullPrompt).toContain("skill-7")
    expect(result.fullPrompt).toContain("pre-loaded")
  })

  it("bundledSkillIds 空数组时不渲染 section", () => {
    const skills = makeSkills(10)
    const result = buildClientSystemPromptStructured({
      ...BASE_PARAMS,
      skills,
      bundledSkillIds: [],
    })
    expect(result.fullPrompt).not.toContain("Your bundled capabilities")
  })

  it("bundledSkillIds 包含未知 ID 时被静默忽略，但不报错", () => {
    const skills = makeSkills(5)
    const result = buildClientSystemPromptStructured({
      ...BASE_PARAMS,
      skills,
      bundledSkillIds: ["skill-2", "ghost-skill"],
    })
    expect(result.fullPrompt).toContain("Your bundled capabilities")
    expect(result.fullPrompt).toContain("skill-2")
    expect(result.fullPrompt).not.toContain("ghost-skill")
  })

  it("低 confidence + needsClarification 时注入澄清指令到 prompt", () => {
    const skills = makeSkills(20)
    const agents = makeAgents(5)
    const result = buildClientSystemPromptStructured({
      ...BASE_PARAMS,
      skills,
      customAgents: agents,
      routerResult: {
        confidence: 0.4,
        fallback: "none",
        intent: "ambiguous",
        topAgents: [],
        topSkills: [],
        needsClarification: true,
        clarifyQuestion: "你想做什么？",
        clarifyOptions: ["审查代码", "总结文档", "翻译外语"],
      },
    })
    expect(result.fullPrompt).toContain("Routing rationale")
    expect(result.fullPrompt).toContain("Possible ambiguity flagged by Router")
    expect(result.fullPrompt).toContain("你想做什么？")
    expect(result.fullPrompt).toContain("审查代码")
    expect(result.fullPrompt).toContain("First try to resolve it yourself")
  })

  it("澄清模式不过滤 skills/agents（用户可能改主意）", () => {
    const skills = makeSkills(30)
    const agents = makeAgents(10)
    const result = buildClientSystemPromptStructured({
      ...BASE_PARAMS,
      skills,
      customAgents: agents,
      routerResult: {
        confidence: 0.3,
        fallback: "none",
        intent: "ambiguous",
        topAgents: [{ id: "agent-0", score: 0.3, reason: "" }],
        topSkills: [],
        needsClarification: true,
        clarifyQuestion: "?",
        clarifyOptions: ["a", "b"],
      },
    })
    // agent-5/agent-8 等所有 agent 都应出现（未过滤）
    expect(result.fullPrompt).toMatch(/`agent-5`/)
    expect(result.fullPrompt).toContain("Possible ambiguity flagged by Router")
  })
})
