import { describe, it, expect } from "vitest";
import {
  isNetworkErrorCode,
  mapAgentSignalToPetEvent,
  type AgentSignal,
} from "./agentSignalMapper.js";

describe("isNetworkErrorCode", () => {
  it("识别常见网络类 errno（大小写不敏感）", () => {
    expect(isNetworkErrorCode("ECONNRESET")).toBe(true);
    expect(isNetworkErrorCode("etimedout")).toBe(true);
    expect(isNetworkErrorCode("ENOTFOUND")).toBe(true);
    expect(isNetworkErrorCode("network_error")).toBe(true);
  });

  it("识别 stream_error 等 LLM 流失败为网络错误", () => {
    expect(isNetworkErrorCode("stream_error")).toBe(true);
  });

  it("非网络 code 与空值返回 false", () => {
    expect(isNetworkErrorCode("safety_blocked")).toBe(false);
    expect(isNetworkErrorCode("unknown")).toBe(false);
    expect(isNetworkErrorCode(undefined)).toBe(false);
    expect(isNetworkErrorCode("")).toBe(false);
  });
});

describe("mapAgentSignalToPetEvent", () => {
  it("delta → AGENT_DELTA", () => {
    expect(mapAgentSignalToPetEvent({ kind: "delta" })).toEqual({ type: "AGENT_DELTA" });
  });

  it("final → AGENT_FINAL", () => {
    expect(mapAgentSignalToPetEvent({ kind: "final" })).toEqual({ type: "AGENT_FINAL" });
  });

  it("safety_blocked → SAFETY_BLOCKED", () => {
    expect(mapAgentSignalToPetEvent({ kind: "safety_blocked" })).toEqual({
      type: "SAFETY_BLOCKED",
    });
  });

  it("tts_failed → TTS_FAILED", () => {
    expect(mapAgentSignalToPetEvent({ kind: "tts_failed" })).toEqual({
      type: "TTS_FAILED",
    });
  });

  it("网络类 error → NETWORK_ERROR（可 RETRY 自愈）", () => {
    expect(mapAgentSignalToPetEvent({ kind: "error", code: "ETIMEDOUT" })).toEqual({
      type: "NETWORK_ERROR",
    });
    expect(mapAgentSignalToPetEvent({ kind: "error", code: "stream_error" })).toEqual({
      type: "NETWORK_ERROR",
    });
  });

  it("非网络 error → null（由 UI 用宠物语气提示，不切状态机）", () => {
    expect(mapAgentSignalToPetEvent({ kind: "error", code: "bad_request" })).toBeNull();
    expect(mapAgentSignalToPetEvent({ kind: "error" })).toBeNull();
  });

  it("noop → null", () => {
    expect(mapAgentSignalToPetEvent({ kind: "noop" })).toBeNull();
  });

  it("未知 kind → null（健壮性兜底）", () => {
    expect(mapAgentSignalToPetEvent({ kind: "weird" } as unknown as AgentSignal)).toBeNull();
  });
});
