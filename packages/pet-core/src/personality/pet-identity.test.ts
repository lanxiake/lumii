import { describe, it, expect } from "vitest";
import { petAgentId } from "./pet-identity.js";

describe("petAgentId", () => {
  it("加 pet: 前缀，与 assistant 分属不同 agent", () => {
    expect(petAgentId("demo_cartoon_cat")).toBe("pet:demo_cartoon_cat");
    expect(petAgentId("demo_cartoon_cat")).not.toBe("assistant");
  });

  it("同模型稳定、不同模型不同", () => {
    expect(petAgentId("mao_pro")).toBe(petAgentId("mao_pro"));
    expect(petAgentId("mao_pro")).not.toBe(petAgentId("ug_official"));
  });
});
