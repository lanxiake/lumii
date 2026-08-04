import { describe, it, expect, beforeEach } from "vitest";
import {
  createBudgetTracker,
  checkTokenBudget,
  getBudgetContinuationMessage,
  type BudgetTracker,
} from "../token-budget.js";

describe("token-budget", () => {
  let tracker: BudgetTracker;

  beforeEach(() => {
    tracker = createBudgetTracker();
  });

  describe("createBudgetTracker", () => {
    it("初始化所有计数器为 0", () => {
      expect(tracker.continuationCount).toBe(0);
      expect(tracker.lastDeltaTokens).toBe(0);
      expect(tracker.lastGlobalTurnTokens).toBe(0);
      expect(tracker.startedAt).toBeGreaterThan(0);
    });
  });

  describe("checkTokenBudget", () => {
    it("子 Agent 跳过预算检查", () => {
      const result = checkTokenBudget(tracker, "child-1", 100_000, 50_000);
      expect(result.action).toBe("stop");
      expect(result.completionEvent).toBeNull();
    });

    it("null budget 跳过检查", () => {
      const result = checkTokenBudget(tracker, undefined, null, 50_000);
      expect(result.action).toBe("stop");
      expect(result.completionEvent).toBeNull();
    });

    it("零 budget 跳过检查", () => {
      const result = checkTokenBudget(tracker, undefined, 0, 50_000);
      expect(result.action).toBe("stop");
      expect(result.completionEvent).toBeNull();
    });

    it("负 budget 跳过检查", () => {
      const result = checkTokenBudget(tracker, undefined, -100, 50_000);
      expect(result.action).toBe("stop");
      expect(result.completionEvent).toBeNull();
    });

    it("低于 90% 阈值 → continue（首次）", () => {
      const result = checkTokenBudget(tracker, undefined, 100_000, 50_000);
      expect(result.action).toBe("continue");
      if (result.action === "continue") {
        expect(result.pct).toBe(50);
        expect(result.turnTokens).toBe(50_000);
        expect(result.budget).toBe(100_000);
        expect(result.continuationCount).toBe(1);
        expect(result.nudgeMessage).toContain("50%");
        expect(result.nudgeMessage).toContain("Keep working");
      }
      expect(tracker.continuationCount).toBe(1);
      expect(tracker.lastGlobalTurnTokens).toBe(50_000);
      expect(tracker.lastDeltaTokens).toBe(50_000);
    });

    it("连续 continue 更新计数器和增量", () => {
      checkTokenBudget(tracker, undefined, 100_000, 30_000); // +30k
      expect(tracker.continuationCount).toBe(1);
      expect(tracker.lastDeltaTokens).toBe(30_000);

      checkTokenBudget(tracker, undefined, 100_000, 50_000); // +20k
      expect(tracker.continuationCount).toBe(2);
      expect(tracker.lastDeltaTokens).toBe(20_000);

      checkTokenBudget(tracker, undefined, 100_000, 70_000); // +20k
      expect(tracker.continuationCount).toBe(3);
      expect(tracker.lastDeltaTokens).toBe(20_000);
    });

    it("达到 90% 阈值 → stop with completionEvent", () => {
      checkTokenBudget(tracker, undefined, 100_000, 50_000); // 50%
      checkTokenBudget(tracker, undefined, 100_000, 70_000); // 70%
      const result = checkTokenBudget(tracker, undefined, 100_000, 91_000); // 91% 超限

      expect(result.action).toBe("stop");
      if (result.action === "stop") {
        expect(result.completionEvent).not.toBeNull();
        expect(result.completionEvent?.pct).toBe(91);
        expect(result.completionEvent?.diminishingReturns).toBe(false);
        expect(result.completionEvent?.continuationCount).toBe(2);
      }
    });

    it("边际递减（连续 3 轮增量 <500）→ stop with diminishingReturns", () => {
      checkTokenBudget(tracker, undefined, 100_000, 30_000); // +30k
      checkTokenBudget(tracker, undefined, 100_000, 30_400); // +400
      checkTokenBudget(tracker, undefined, 100_000, 30_700); // +300
      const result = checkTokenBudget(tracker, undefined, 100_000, 30_900); // +200 第4轮

      expect(result.action).toBe("stop");
      if (result.action === "stop") {
        expect(result.completionEvent?.diminishingReturns).toBe(true);
        expect(result.completionEvent?.continuationCount).toBe(3);
        expect(result.completionEvent?.pct).toBe(31);
      }
    });

    it("边际递减停止非永久：增量回升后重新 continue", () => {
      // 前 4 轮触发边际递减停止
      checkTokenBudget(tracker, undefined, 100_000, 10_000);
      checkTokenBudget(tracker, undefined, 100_000, 10_300);
      checkTokenBudget(tracker, undefined, 100_000, 10_500);
      const stopResult = checkTokenBudget(tracker, undefined, 100_000, 10_600);
      expect(stopResult.action).toBe("stop");
      // tracker.lastGlobalTurnTokens 仍停留在最后一次 continue 的值（10_500）

      // 增量大幅回升（delta = 20_000 - 10_500 = 9_500 > 500）→ 重新 continue
      const result = checkTokenBudget(tracker, undefined, 100_000, 20_000);
      expect(result.action).toBe("continue");
    });

    it("从未触发 continuation 且超限 → 静默 stop（completionEvent=null）", () => {
      const result = checkTokenBudget(tracker, undefined, 100_000, 95_000);
      expect(result.action).toBe("stop");
      expect(result.completionEvent).toBeNull(); // 从未 continue 过
    });
  });

  describe("getBudgetContinuationMessage", () => {
    it("生成格式化 nudge 消息", () => {
      const msg = getBudgetContinuationMessage(50, 50_000, 100_000);
      expect(msg).toContain("50%");
      expect(msg).toContain("50,000");
      expect(msg).toContain("100,000");
      expect(msg).toContain("Keep working");
      expect(msg).toContain("do not summarize");
    });

    it("千分位格式化", () => {
      const msg = getBudgetContinuationMessage(87, 870_000, 1_000_000);
      expect(msg).toContain("870,000");
      expect(msg).toContain("1,000,000");
    });
  });
});
