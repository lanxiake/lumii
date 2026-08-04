import { describe, expect, it } from "vitest"
import { RouterHitRateTracker } from "./router-hit-rate-tracker"
import type { RouterResult } from "./types"

function makeResult(overrides: Partial<RouterResult> = {}): RouterResult {
  return {
    intent: "test",
    confidence: 0.9,
    topAgents: [{ id: "agent-A", score: 0.9, reason: "" }],
    topSkills: [
      { id: "skill-X", score: 0.9, reason: "" },
      { id: "skill-Y", score: 0.7, reason: "" },
    ],
    needsClarification: false,
    durationMs: 250,
    fallback: "none",
    ...overrides,
  }
}

describe("RouterHitRateTracker", () => {
  it("记录基本字段", () => {
    const t = new RouterHitRateTracker()
    t.record("inst-1", makeResult())
    const recs = t.exportRecords()
    expect(recs).toHaveLength(1)
    expect(recs[0]?.topAgentId).toBe("agent-A")
    expect(recs[0]?.topSkillIds).toEqual(["skill-X", "skill-Y"])
    expect(recs[0]?.hitLevel).toBeUndefined() // 未上报 actualChoice
  })

  it("actualAgentId 命中 top1", () => {
    const t = new RouterHitRateTracker()
    t.record("inst-1", makeResult())
    t.recordActualChoice("inst-1", "agent-A")
    expect(t.exportRecords()[0]?.hitLevel).toBe("top1")
  })

  it("actualAgentId 未命中", () => {
    const t = new RouterHitRateTracker()
    t.record("inst-1", makeResult())
    t.recordActualChoice("inst-1", "agent-other")
    expect(t.exportRecords()[0]?.hitLevel).toBe("miss")
  })

  it("Skill 命中 top1（actualSkill[0] === router top1）", () => {
    const t = new RouterHitRateTracker()
    t.record("inst-1", makeResult())
    t.recordActualChoice("inst-1", undefined, ["skill-X"])
    expect(t.exportRecords()[0]?.hitLevel).toBe("top1")
  })

  it("Skill 命中 top3（actualSkill 在 router 推荐中但非 top1）", () => {
    const t = new RouterHitRateTracker()
    t.record("inst-1", makeResult())
    t.recordActualChoice("inst-1", undefined, ["skill-Y"])
    expect(t.exportRecords()[0]?.hitLevel).toBe("top3")
  })

  it("fallback 时 hitLevel = unknown", () => {
    const t = new RouterHitRateTracker()
    t.record("inst-1", makeResult({ fallback: "timeout", confidence: 0 }))
    t.recordActualChoice("inst-1", "agent-A")
    expect(t.exportRecords()[0]?.hitLevel).toBe("unknown")
  })

  it("getSummary 计算正确", () => {
    const t = new RouterHitRateTracker()
    t.record("a", makeResult({ fallback: "none", durationMs: 200 }))
    t.recordActualChoice("a", "agent-A") // top1
    t.record("b", makeResult({ fallback: "none", durationMs: 400 }))
    t.recordActualChoice("b", "agent-other") // miss
    t.record("c", makeResult({ fallback: "timeout", durationMs: 800 }))
    t.record("d", makeResult({ needsClarification: true, durationMs: 300 }))

    const s = t.getSummary()
    expect(s.total).toBe(4)
    expect(s.fallbackRate).toBeCloseTo(0.25)
    expect(s.clarifyRate).toBeCloseTo(0.25)
    expect(s.avgDurationMs).toBeCloseTo((200 + 400 + 800 + 300) / 4)
    expect(s.top1Rate).toBeCloseTo(0.5) // 1/2 evaluated
    expect(s.missRate).toBeCloseTo(0.5)
  })

  it("maxRecords 上限保护", () => {
    const t = new RouterHitRateTracker({ maxRecords: 3 })
    for (let i = 0; i < 10; i++) {
      t.record(`inst-${i}`, makeResult())
    }
    expect(t.exportRecords()).toHaveLength(3)
    expect(t.exportRecords()[0]?.instanceId).toBe("inst-7")
  })

  it("clear 清空所有记录", () => {
    const t = new RouterHitRateTracker()
    t.record("a", makeResult())
    t.record("b", makeResult())
    t.clear()
    expect(t.exportRecords()).toHaveLength(0)
  })

  it("空 records 时 getSummary 返回零值", () => {
    const t = new RouterHitRateTracker()
    const s = t.getSummary()
    expect(s.total).toBe(0)
    expect(s.top1Rate).toBe(0)
  })
})
