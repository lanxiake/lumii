import { describe, expect, it } from "vitest"
import { tryRouterFastPath } from "./router-fast-path"
import type { RouterInput } from "./types"

const BASE_INPUT: RouterInput = {
  userInput: "你好",
  availableAgents: [
    { id: "assistant", name: "系统默认", description: "通用入口" },
    { id: "builtin:explore", name: "Explore", description: "" },
  ],
  availableSkills: [{ id: "weather", name: "Weather", description: "" }],
}

describe("tryRouterFastPath", () => {
  it("寒暄走快路径，不调用 LLM", () => {
    const result = tryRouterFastPath(BASE_INPUT)
    expect(result).not.toBeNull()
    expect(result!.intent).toBe("chitchat")
    expect(result!.fallback).toBe("none")
    expect(result!.topAgents[0]?.id).toBe("assistant")
    expect(result!.topSkills).toHaveLength(0)
  })

  it("非寒暄返回 null", () => {
    expect(tryRouterFastPath({ ...BASE_INPUT, userInput: "帮我画一张猫" })).toBeNull()
  })

  it("支持英文 hello", () => {
    const result = tryRouterFastPath({ ...BASE_INPUT, userInput: "hello" })
    expect(result?.intent).toBe("chitchat")
  })
})
