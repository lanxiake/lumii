import { describe, expect, it, vi } from "vitest"
import type { RouterLlmCaller } from "./llm-caller"
import { RouterService } from "./router-service"
import type { RouterInput } from "./types"

const INPUT: RouterInput = {
  userInput: "帮我画一张猫的图",
  availableAgents: [{ id: "image-agent", name: "Image", description: "" }],
  availableSkills: [{ id: "image-generate", name: "ImgGen", description: "" }],
}

function makeCaller(behavior: (prompt: string, timeoutMs: number) => Promise<string>): RouterLlmCaller {
  return { call: behavior }
}

describe("RouterService", () => {
  it("成功路径：返回 fallback=none 和正确字段", async () => {
    const caller = makeCaller(async () =>
      JSON.stringify({
        intent: "image_gen",
        confidence: 0.92,
        topAgents: [{ id: "image-agent", score: 0.9, reason: "用户想画图" }],
        topSkills: [{ id: "image-generate", score: 0.95, reason: "生成图片" }],
        needsClarification: false,
      }),
    )
    const svc = new RouterService({ llmCaller: caller })
    const result = await svc.route(INPUT)
    expect(result.fallback).toBe("none")
    expect(result.intent).toBe("image_gen")
    expect(result.confidence).toBe(0.92)
    expect(result.topAgents[0]?.id).toBe("image-agent")
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("timeout：返回 fallback=timeout 并附带占位候选", async () => {
    const caller = makeCaller(async () => {
      throw new Error("Router call timeout after 800ms")
    })
    const svc = new RouterService({ llmCaller: caller, timeoutMs: 50 })
    const result = await svc.route(INPUT)
    expect(result.fallback).toBe("timeout")
    expect(result.confidence).toBe(0)
    expect(result.topAgents).toHaveLength(1)
    expect(result.topSkills).toHaveLength(1)
  })

  it("parse_error：重试 1 次后返回 fallback=parse_error", async () => {
    const callCount = { n: 0 }
    const caller = makeCaller(async () => {
      callCount.n++
      return "这完全不是 JSON 输出"
    })
    const svc = new RouterService({ llmCaller: caller, maxRetries: 1 })
    const result = await svc.route(INPUT)
    expect(result.fallback).toBe("parse_error")
    expect(callCount.n).toBe(2) // 首次 + 1 次重试
  })

  it("llm_error：不重试，立刻返回 fallback=llm_error", async () => {
    const callCount = { n: 0 }
    const caller = makeCaller(async () => {
      callCount.n++
      throw new Error("LLM error: network unreachable")
    })
    const svc = new RouterService({ llmCaller: caller, maxRetries: 3 })
    const result = await svc.route(INPUT)
    expect(result.fallback).toBe("llm_error")
    expect(callCount.n).toBe(1) // 不重试
  })

  it("fallback 结果保留 input 的前 N 个 Agent/Skill 占位", async () => {
    const input: RouterInput = {
      userInput: "x",
      availableAgents: Array.from({ length: 10 }, (_, i) => ({
        id: `a${i}`,
        name: `a${i}`,
        description: "",
      })),
      availableSkills: Array.from({ length: 20 }, (_, i) => ({
        id: `s${i}`,
        name: `s${i}`,
        description: "",
      })),
    }
    const caller = makeCaller(async () => {
      throw new Error("boom")
    })
    const svc = new RouterService({ llmCaller: caller })
    const result = await svc.route(input)
    expect(result.topAgents).toHaveLength(3)
    expect(result.topSkills).toHaveLength(5)
  })

  it("校验剔除 LLM 编造的不存在 ID", async () => {
    const caller = makeCaller(async () =>
      JSON.stringify({
        intent: "x",
        confidence: 0.9,
        topAgents: [
          { id: "image-agent", score: 0.9, reason: "" },
          { id: "ghost-agent", score: 0.8, reason: "" },
        ],
        topSkills: [{ id: "phantom-skill", score: 0.7, reason: "" }],
        needsClarification: false,
      }),
    )
    const svc = new RouterService({ llmCaller: caller })
    const result = await svc.route(INPUT)
    expect(result.topAgents.map((a) => a.id)).toEqual(["image-agent"])
    expect(result.topSkills).toEqual([])
  })

  it("寒暄走快路径，不调用 LLM", async () => {
    const spy = vi.fn(async () => "should not be called")
    const svc = new RouterService({ llmCaller: { call: spy } })
    const result = await svc.route({
      userInput: "你好",
      availableAgents: [{ id: "assistant", name: "系统默认", description: "" }],
      availableSkills: [],
    })
    expect(result.fallback).toBe("none")
    expect(result.intent).toBe("chitchat")
    expect(spy).not.toHaveBeenCalled()
  })

  it("LLM 调用接收到 prompt 字符串（含用户输入）", async () => {
    const spy = vi.fn(async () =>
      JSON.stringify({
        intent: "x",
        confidence: 0.5,
        topAgents: [],
        topSkills: [],
        needsClarification: false,
      }),
    )
    const svc = new RouterService({ llmCaller: { call: spy } })
    await svc.route(INPUT)
    expect(spy).toHaveBeenCalledOnce()
    const firstCall = spy.mock.calls[0] as unknown as [string, number]
    const promptArg = firstCall[0]
    expect(promptArg).toContain("帮我画一张猫的图")
    expect(promptArg).toContain("image-agent")
    expect(promptArg).toContain("image-generate")
  })

  it("缓存命中：相同输入第二次不再调用 LLM", async () => {
    const spy = vi.fn(async () =>
      JSON.stringify({
        intent: "image_gen",
        confidence: 0.9,
        topAgents: [{ id: "image-agent", score: 0.9, reason: "" }],
        topSkills: [],
        needsClarification: false,
      }),
    )
    const svc = new RouterService({ llmCaller: { call: spy } })
    const first = await svc.route(INPUT)
    const second = await svc.route(INPUT)
    expect(spy).toHaveBeenCalledOnce()
    expect(second.intent).toBe(first.intent)
    expect(second.durationMs).toBe(0)
  })

  it("cacheTtlMs=0 关闭缓存：每次都调用 LLM", async () => {
    const spy = vi.fn(async () =>
      JSON.stringify({
        intent: "x",
        confidence: 0.5,
        topAgents: [],
        topSkills: [],
        needsClarification: false,
      }),
    )
    const svc = new RouterService({ llmCaller: { call: spy }, cacheTtlMs: 0 })
    await svc.route(INPUT)
    await svc.route(INPUT)
    expect(spy).toHaveBeenCalledTimes(2)
  })
})
