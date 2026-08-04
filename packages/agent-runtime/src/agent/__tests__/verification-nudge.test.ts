import { describe, it, expect } from "vitest";
import { shouldNudgeVerification } from "../verification-nudge.js";

const done = (subject: string, description = "") => ({ subject, description, status: "done" });

describe("shouldNudgeVerification", () => {
  it("3+ 任务全 done 且无验证步骤 → 提醒", () => {
    const tasks = [done("实现 A"), done("实现 B"), done("实现 C")];
    expect(shouldNudgeVerification(tasks)).toBe(true);
  });

  it("含验证步骤（中/英关键词）→ 不提醒", () => {
    expect(shouldNudgeVerification([done("实现 A"), done("实现 B"), done("运行测试验证")])).toBe(false);
    expect(shouldNudgeVerification([done("impl A"), done("impl B"), done("run tests")])).toBe(false);
    expect(
      shouldNudgeVerification([done("a"), done("b"), done("c", "verify the build passes")]),
    ).toBe(false);
  });

  it("少于 3 个任务 → 不提醒", () => {
    expect(shouldNudgeVerification([done("a"), done("b")])).toBe(false);
  });

  it("存在未完成任务 → 不提醒", () => {
    const tasks = [done("a"), done("b"), { subject: "c", status: "in_progress" }];
    expect(shouldNudgeVerification(tasks)).toBe(false);
  });
});
