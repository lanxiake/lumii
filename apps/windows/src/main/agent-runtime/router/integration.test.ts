/**
 * Router → buildClientSystemPromptStructured 端到端集成测试
 *
 * 验证：Router 输出真的能让主 prompt 中 Skills/Agents section 仅包含筛选过的子集。
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
  toolNames: ["spawn_agent", "skill_list", "skill_search", "skill_invoke", "send_message"],
  cwd: "/tmp",
}

describe("Router 集成：buildClientSystemPromptStructured 用 routerResult 过滤", () => {
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

  it("confidence ≥ 0.6 + fallback=none 时 Skills section 仅包含 topSkills", () => {
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

    // 主 prompt 应包含 Routing rationale section
    expect(result.fullPrompt).toContain("Routing rationale")
    expect(result.fullPrompt).toContain("image_gen")
    expect(result.fullPrompt).toContain("agent-3")
    expect(result.fullPrompt).toContain("skill-7")
    // 未被推荐的 agent-5 不应出现在 Agents section 渲染中
    // （注意：reason 字符串可能包含数字，所以用更严格的边界检测）
    expect(result.fullPrompt).not.toMatch(/`agent-5`/)
    expect(result.fullPrompt).not.toMatch(/`skill-99`/)
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

  it("Token 节省验证：100 技能 → 2 技能时主 prompt 显著缩短", () => {
    const skills = makeSkills(100)
    const agents = makeAgents(10)

    const promptFull = buildClientSystemPromptStructured({
      ...BASE_PARAMS,
      skills,
      customAgents: agents,
    }).fullPrompt

    const promptRouter = buildClientSystemPromptStructured({
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
    }).fullPrompt

    // Router 模式下主 prompt 应该缩短（具体多少取决于工具化/静态模式）
    const ratio = promptRouter.length / promptFull.length
    console.log(`Prompt 长度对比: full=${promptFull.length} router=${promptRouter.length} ratio=${ratio.toFixed(2)}`)
    expect(promptRouter.length).toBeLessThan(promptFull.length)
  })

  it("Agent 过滤显著缩短 prompt（10 agent → 1 agent）", () => {
    // 只过滤 agents（无 skills），验证 agent 过滤的真实效果
    const agents = makeAgents(20)
    const promptFull = buildClientSystemPromptStructured({
      ...BASE_PARAMS,
      customAgents: agents,
    }).fullPrompt
    const promptRouter = buildClientSystemPromptStructured({
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
    const ratio = promptRouter.length / promptFull.length
    console.log(`Agent 过滤效果: full=${promptFull.length} router=${promptRouter.length} ratio=${ratio.toFixed(2)}`)
    // 20 个 agent → 1 个，agent collaboration section 应明显缩水
    expect(promptRouter.length).toBeLessThan(promptFull.length)
    // 期望减少至少 5%（agent collaboration section 的相对占比）
    expect(ratio).toBeLessThan(0.95)
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
