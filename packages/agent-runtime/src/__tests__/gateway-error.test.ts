import { describe, it, expect } from "vitest";
import { gatewayErrorFromHttpResponse } from "../llm/gateway-stream.js";

describe("gatewayErrorFromHttpResponse", () => {
  it("解析 402 billing 错误", () => {
    const body = JSON.stringify({
      error: { message: "Insufficient credits", type: "billing_error" },
    });
    const e = gatewayErrorFromHttpResponse(402, body);
    expect(e.code).toBe("billing_error");
    expect(e.retryable).toBe(false);
    expect(e.httpStatus).toBe(402);
    expect(e.message).toContain("Insufficient");
  });

  it("429 可重试", () => {
    const e = gatewayErrorFromHttpResponse(429, "{}");
    expect(e.retryable).toBe(true);
  });
});
