import { describe, expect, it } from "vitest"
import { parseRouterResult, validateRouterResult } from "./result-parser"
import type { RouterInput } from "./types"

const MOCK_INPUT: RouterInput = {
  userInput: "test",
  availableAgents: [
    { id: "code-reviewer", name: "Code Reviewer", description: "Review code" },
    { id: "translator", name: "Translator", description: "Translate text" },
  ],
  availableSkills: [
    { id: "image-generate", name: "Image Generate", description: "Gen image" },
    { id: "translate", name: "Translate", description: "Translate" },
  ],
}

describe("parseRouterResult", () => {
  it("解析裸 JSON", () => {
    const raw = JSON.stringify({
      intent: "code_review",
      confidence: 0.9,
      topAgents: [{ id: "code-reviewer", score: 0.95, reason: "代码审查" }],
      topSkills: [],
      needsClarification: false,
    })
    const result = parseRouterResult(raw)
    expect(result.intent).toBe("code_review")
    expect(result.confidence).toBe(0.9)
    expect(result.topAgents).toHaveLength(1)
    expect(result.topAgents[0]?.id).toBe("code-reviewer")
    expect(result.fallback).toBe("none")
  })

  it("解析 markdown 代码块包裹的 JSON", () => {
    const raw = `好的，这是结果：\n\`\`\`json\n${JSON.stringify({
      intent: "translate",
      confidence: 0.8,
      topAgents: [],
      topSkills: [{ id: "translate", score: 0.9, reason: "翻译" }],
      needsClarification: false,
    })}\n\`\`\`\n搞定`
    const result = parseRouterResult(raw)
    expect(result.intent).toBe("translate")
    expect(result.topSkills).toHaveLength(1)
  })

  it("从含前后噪声的文本中抽取首个 JSON 对象", () => {
    const raw = `Reasoning: user wants X.\n{"intent":"x","confidence":0.7,"topAgents":[],"topSkills":[],"needsClarification":false}\nDone.`
    const result = parseRouterResult(raw)
    expect(result.intent).toBe("x")
    expect(result.confidence).toBe(0.7)
  })

  it("score 超界自动 clamp 到 0-1", () => {
    const raw = JSON.stringify({
      intent: "x",
      confidence: 1.5,
      topAgents: [{ id: "a", score: 2.0, reason: "" }],
      topSkills: [{ id: "b", score: -0.5, reason: "" }],
      needsClarification: false,
    })
    const result = parseRouterResult(raw)
    expect(result.confidence).toBe(1)
    expect(result.topAgents[0]?.score).toBe(1)
    expect(result.topSkills[0]?.score).toBe(0)
  })

  it("字段缺失时使用安全默认值", () => {
    const raw = `{}`
    const result = parseRouterResult(raw)
    expect(result.intent).toBe("unknown")
    expect(result.confidence).toBe(0)
    expect(result.topAgents).toEqual([])
    expect(result.topSkills).toEqual([])
    expect(result.needsClarification).toBe(false)
  })

  it("非 JSON 输入抛出 parse_error", () => {
    expect(() => parseRouterResult("这完全不是 JSON")).toThrow(/parse_error/)
  })

  it("topAgents 超过 3 个自动截断", () => {
    const raw = JSON.stringify({
      intent: "x",
      confidence: 0.5,
      topAgents: [1, 2, 3, 4, 5].map((i) => ({ id: `a${i}`, score: 0.5, reason: "" })),
      topSkills: [],
      needsClarification: false,
    })
    const result = parseRouterResult(raw)
    expect(result.topAgents).toHaveLength(3)
  })
})

describe("validateRouterResult", () => {
  it("剔除不存在的 Agent/Skill ID", () => {
    const result = parseRouterResult(
      JSON.stringify({
        intent: "x",
        confidence: 0.9,
        topAgents: [
          { id: "code-reviewer", score: 0.9, reason: "" }, // 存在
          { id: "ghost-agent", score: 0.8, reason: "" }, // 不存在
        ],
        topSkills: [
          { id: "translate", score: 0.7, reason: "" }, // 存在
          { id: "ghost-skill", score: 0.6, reason: "" }, // 不存在
        ],
        needsClarification: false,
      }),
    )
    const validated = validateRouterResult(result, MOCK_INPUT)
    expect(validated.topAgents.map((a) => a.id)).toEqual(["code-reviewer"])
    expect(validated.topSkills.map((s) => s.id)).toEqual(["translate"])
  })
})
