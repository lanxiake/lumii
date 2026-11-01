import { describe, expect, it } from "vitest";
import {
  extendMsFromAgentRenewalReply,
  extractJsonObject,
  parseRenewalExtendMs,
} from "./bash-renewal.js";

describe("parseRenewalExtendMs", () => {
  it("识别不续期", () => {
    expect(parseRenewalExtendMs("不续期")).toBe(0);
    expect(parseRenewalExtendMs("no")).toBe(0);
  });

  it("解析秒/分钟/毫秒与纯数字", () => {
    expect(parseRenewalExtendMs("120s")).toBe(120_000);
    expect(parseRenewalExtendMs("2m")).toBe(120_000);
    expect(parseRenewalExtendMs("2分钟")).toBe(120_000);
    expect(parseRenewalExtendMs("500ms")).toBe(500);
    expect(parseRenewalExtendMs("90")).toBe(90_000);
    expect(parseRenewalExtendMs("120000")).toBe(120_000);
  });
});

describe("extractJsonObject / extendMsFromAgentRenewalReply", () => {
  it("解析裸 JSON 与 fence", () => {
    expect(extractJsonObject('{"renew":false}')).toEqual({ renew: false });
    expect(extractJsonObject('```json\n{"renew":true,"extendMs":120000}\n```')).toEqual({
      renew: true,
      extendMs: 120000,
    });
  });

  it("renew:false → 0", () => {
    expect(extendMsFromAgentRenewalReply('{"renew":false}')).toBe(0);
  });

  it("renew:true + extendMs", () => {
    expect(extendMsFromAgentRenewalReply('{"renew":true,"extendMs":300000}')).toBe(300_000);
  });

  it("renew:true 无时长 → 默认 2 分钟", () => {
    expect(extendMsFromAgentRenewalReply('{"renew":true}')).toBe(120_000);
  });

  it("超过上限截断", () => {
    expect(extendMsFromAgentRenewalReply('{"renew":true,"extendMs":9999999}')).toBe(600_000);
  });

  it("杂讯前后缀仍可解析", () => {
    expect(
      extendMsFromAgentRenewalReply('Sure.\n{"renew":true,"extendMs":180000}\nThanks'),
    ).toBe(180_000);
  });
});
