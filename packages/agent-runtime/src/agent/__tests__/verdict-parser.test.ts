import { describe, it, expect } from "vitest";
import { parseVerdict, formatVerdictBanner } from "../verdict-parser.js";

describe("parseVerdict", () => {
  it("解析 PASS/FAIL/PARTIAL", () => {
    expect(parseVerdict("...\nVERDICT: PASS").verdict).toBe("PASS");
    expect(parseVerdict("VERDICT: FAIL\n").verdict).toBe("FAIL");
    expect(parseVerdict("VERDICT: PARTIAL").verdict).toBe("PARTIAL");
  });

  it("大小写不敏感 + 容忍空白", () => {
    expect(parseVerdict("verdict:   fail").verdict).toBe("FAIL");
    expect(parseVerdict("Verdict: Pass").verdict).toBe("PASS");
  });

  it("多处出现时取最后一处", () => {
    const out = "VERDICT: PASS\n中间分析又写了 VERDICT: PARTIAL\n最终 VERDICT: FAIL";
    expect(parseVerdict(out).verdict).toBe("FAIL");
  });

  it("无 VERDICT → UNKNOWN", () => {
    expect(parseVerdict("一切看起来都没问题").verdict).toBe("UNKNOWN");
    expect(parseVerdict("").verdict).toBe("UNKNOWN");
  });

  it("formatVerdictBanner 含机器可读前缀与行动引导", () => {
    expect(formatVerdictBanner("PASS")).toContain("[VERIFY RESULT: PASS]");
    expect(formatVerdictBanner("FAIL")).toContain("[VERIFY RESULT: FAIL]");
    expect(formatVerdictBanner("FAIL")).toMatch(/修复/);
    expect(formatVerdictBanner("PARTIAL")).toContain("[VERIFY RESULT: PARTIAL]");
    expect(formatVerdictBanner("UNKNOWN")).toContain("[VERIFY RESULT: UNKNOWN]");
  });
});
