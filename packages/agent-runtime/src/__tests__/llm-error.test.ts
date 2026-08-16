/**
 * llm-error 单测 —— 直连/网关两条链路共用的错误归一化
 *
 * 回归场景：客户端填错 API Key 时，provider 只回一句 "401 无效的令牌 (request id: ...)"，
 * 必须能被归一化成 unauthorized，否则 UI 会把这轮当成空回复静默丢弃。
 */

import { describe, it, expect } from "vitest";
import type { AgentEvent } from "@mariozechner/pi-agent-core";

import {
  describeLlmError,
  inferHttpStatusFromMessage,
  normalizeLlmError,
} from "../llm/llm-error.js";
import { mapAgentEvent } from "../types/events.js";

describe("normalizeLlmError", () => {
  it("从自由文本识别 401，判为不可重试的 unauthorized", () => {
    const e = normalizeLlmError("401 无效的令牌 (request id: 20260816134910162752333Eu5JOHdT)");
    expect(e.code).toBe("unauthorized");
    expect(e.httpStatus).toBe(401);
    expect(e.retryable).toBe(false);
  });

  it("429 判为可重试的限流", () => {
    const e = normalizeLlmError("HTTP 429 Too Many Requests");
    expect(e.code).toBe("rate_limited");
    expect(e.retryable).toBe(true);
  });

  it("不把 request id 里的数字段误判为状态码", () => {
    expect(inferHttpStatusFromMessage("request id: 20260816134910162752333")).toBeUndefined();
  });

  it("无状态码的网络异常按可重试处理", () => {
    const e = normalizeLlmError("fetch failed: ECONNREFUSED", { code: "stream_error" });
    expect(e.code).toBe("stream_error");
    expect(e.retryable).toBe(true);
  });

  it("空错误文本也给出可读兜底", () => {
    const e = normalizeLlmError(undefined);
    expect(e.code).toBe("llm_error");
    expect(e.message).not.toBe("");
  });
});

describe("describeLlmError", () => {
  it("已知错误码给出可执行指引并保留服务商原文", () => {
    const text = describeLlmError(normalizeLlmError("401 无效的令牌"));
    expect(text).toContain("API Key");
    expect(text).toContain("401 无效的令牌");
  });

  it("未知错误码回落为通用文案", () => {
    const text = describeLlmError({ code: "weird_code", message: "boom", retryable: false });
    expect(text).toBe("模型调用失败：boom");
  });
});

describe("mapAgentEvent message_end", () => {
  /** 构造 direct 直连失败时 pi-ai 给出的 message_end（只有 errorMessage，无 __llmError） */
  function directErrorEvent(): AgentEvent {
    return {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "401 无效的令牌 (request id: 2026)",
        content: [],
        model: "deepseek-v4-flash",
        api: "openai-completions",
      },
    } as unknown as AgentEvent;
  }

  it("direct 直连出错时合成 llmError，避免 UI 收到无错误信息的空消息", () => {
    const mapped = mapAgentEvent("agent-1", directErrorEvent(), "");
    expect(mapped).toMatchObject({
      type: "message:end",
      stopReason: "error",
      llmError: { code: "unauthorized", httpStatus: 401 },
    });
  });

  it("正常结束不附带 llmError", () => {
    const mapped = mapAgentEvent(
      "agent-1",
      {
        type: "message_end",
        message: { role: "assistant", stopReason: "stop", content: [] },
      } as unknown as AgentEvent,
      "hello",
    );
    expect(mapped).toMatchObject({ type: "message:end", stopReason: "end_turn" });
    expect((mapped as { llmError?: unknown }).llmError).toBeUndefined();
  });

  it("网关已挂载的结构化错误优先于文本推断", () => {
    const mapped = mapAgentEvent(
      "agent-1",
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "429 rate limited",
          __llmError: { code: "billing_error", message: "余额不足", retryable: false },
          content: [],
        },
      } as unknown as AgentEvent,
      "",
    );
    expect((mapped as { llmError?: { code: string } }).llmError?.code).toBe("billing_error");
  });
});
