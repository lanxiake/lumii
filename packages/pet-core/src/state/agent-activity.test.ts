import { describe, it, expect } from "vitest";
import {
  BLOCKED_HOLD_MS,
  WORK_SEGMENT_GAP_MS,
  initialAgentActivity,
  mapAgentEvent,
  reduceAgentActivity,
  sanitizeTimestamp,
  tickAgentActivity,
  type AgentActivityState,
} from "./agent-activity.js";

/** 把一串 (事件, 时刻) 依次喂进去，返回末态 */
function run(
  start: AgentActivityState,
  steps: readonly (readonly [Parameters<typeof reduceAgentActivity>[1], number])[],
): AgentActivityState {
  return steps.reduce((acc, [ev, at]) => reduceAgentActivity(acc, ev, at), start);
}

const S = initialAgentActivity;

describe("reduceAgentActivity — 主干转移", () => {
  it("turn-start 进 thinking，并把本轮计数清零", () => {
    const s = run(S, [
      [{ type: "turn-start" }, 1000],
      [{ type: "tool-start" }, 1100],
      [{ type: "tool-end" }, 1200],
    ]);
    expect(s.toolCount).toBe(1);

    const next = reduceAgentActivity(s, { type: "turn-start" }, 2000);
    expect(next.activity).toBe("thinking");
    expect(next.toolCount).toBe(0);
    expect(next.turnStartedAt).toBe(2000);
    expect(next.lastToolEndAt).toBeNull();
  });

  it("tool-start 进 working 且**清掉迟滞锚点**——段在继续，不能被上一个工具的结束时刻误判", () => {
    const s = run(S, [
      [{ type: "turn-start" }, 1000],
      [{ type: "tool-start" }, 1100],
      [{ type: "tool-end" }, 1200],
    ]);
    expect(s.lastToolEndAt).toBe(1200);

    const next = reduceAgentActivity(s, { type: "tool-start" }, 1300);
    expect(next.activity).toBe("working");
    expect(next.lastToolEndAt).toBeNull();
  });

  it("tool-end 只记时刻与计数，**当场不切状态**", () => {
    const s = run(S, [
      [{ type: "turn-start" }, 1000],
      [{ type: "tool-start" }, 1100],
      [{ type: "tool-end" }, 1200],
    ]);
    expect(s.activity).toBe("working");
    expect(s.toolCount).toBe(1);
    expect(s.lastToolEndAt).toBe(1200);
  });

  it("turn-end 整轮清零回 idle", () => {
    const s = run(S, [
      [{ type: "turn-start" }, 1000],
      [{ type: "tool-start" }, 1100],
      [{ type: "tool-end" }, 1200],
      [{ type: "turn-end" }, 5000],
    ]);
    expect(s.activity).toBe("idle");
    expect(s.turnStartedAt).toBeNull();
    expect(s.toolCount).toBe(0);
    expect(s.lastToolEndAt).toBeNull();
  });
});

describe("工具段迟滞——本模块存在的理由", () => {
  it("段内连续工具不被腰斩（实测段内间隔 2–12ms，远小于迟滞窗口）", () => {
    // 三个工具，每个 100ms 跑完，工具之间隔 10ms —— 全程必须一直是 working
    let s = run(S, [[{ type: "turn-start" }, 1000]]);
    const stops = [
      [1100, 1200],
      [1210, 1300],
      [1310, 1400],
    ] as const;
    for (const [startAt, endAt] of stops) {
      s = reduceAgentActivity(s, { type: "tool-start" }, startAt);
      s = reduceAgentActivity(s, { type: "tool-end" }, endAt);
      // 每个工具结束后立刻 tick 一次（模拟渲染帧）——都不该切走
      s = tickAgentActivity(s, endAt + 50);
      expect(s.activity).toBe("working");
    }
    expect(s.toolCount).toBe(3);
  });

  it("静默满 WORK_SEGMENT_GAP_MS 才切成 thinking", () => {
    let s = run(S, [
      [{ type: "turn-start" }, 1000],
      [{ type: "tool-start" }, 1100],
      [{ type: "tool-end" }, 1200],
    ]);
    s = tickAgentActivity(s, 1200 + WORK_SEGMENT_GAP_MS - 1);
    expect(s.activity).toBe("working");
    s = tickAgentActivity(s, 1200 + WORK_SEGMENT_GAP_MS);
    expect(s.activity).toBe("thinking");
  });

  it("「模型重新思考 5 秒」会正确地切成 thinking（那 5 秒确实在思考）", () => {
    let s = run(S, [
      [{ type: "turn-start" }, 1000],
      [{ type: "tool-start" }, 1100],
      [{ type: "tool-end" }, 1200],
    ]);
    s = tickAgentActivity(s, 6200);
    expect(s.activity).toBe("thinking");
    // 之后再来工具，又能回到 working
    s = reduceAgentActivity(s, { type: "tool-start" }, 6300);
    expect(s.activity).toBe("working");
  });

  it("轮已结束时的静默回落是 idle 而不是 thinking", () => {
    let s = run(S, [
      [{ type: "turn-start" }, 1000],
      [{ type: "tool-start" }, 1100],
      [{ type: "tool-end" }, 1200],
    ]);
    // turn-end 会直接归零，所以构造一个「轮信息已丢但还在 working」的态：
    s = { ...s, turnStartedAt: null };
    s = tickAgentActivity(s, 5000);
    expect(s.activity).toBe("idle");
  });

  it("没有工具结束过（lastToolEndAt=null）时 tick 不切", () => {
    let s = run(S, [
      [{ type: "turn-start" }, 1000],
      [{ type: "tool-start" }, 1100],
    ]);
    s = tickAgentActivity(s, 999999);
    expect(s.activity).toBe("working");
  });
});

describe("waiting——唯一允许强打扰的状态", () => {
  it("进入 waiting 记住来路，响应后回到来路", () => {
    let s = run(S, [
      [{ type: "turn-start" }, 1000],
      [{ type: "tool-start" }, 1100],
      [{ type: "waiting" }, 1200],
    ]);
    expect(s.activity).toBe("waiting");
    expect(s.resumeTo).toBe("working");

    s = reduceAgentActivity(s, { type: "waiting-resolved" }, 1500);
    expect(s.activity).toBe("working");
  });

  it("thinking 时进 waiting，响应后回 thinking（不是硬编码回 working）", () => {
    let s = run(S, [
      [{ type: "turn-start" }, 1000],
      [{ type: "waiting" }, 1100],
      [{ type: "waiting-resolved" }, 1200],
    ]);
    expect(s.activity).toBe("thinking");
  });

  it("连发两次 waiting（permission + ask-user）不覆盖来路", () => {
    let s = run(S, [
      [{ type: "turn-start" }, 1000],
      [{ type: "tool-start" }, 1100],
      [{ type: "waiting" }, 1200],
      [{ type: "waiting" }, 1300],
    ]);
    expect(s.resumeTo).toBe("working");
    s = reduceAgentActivity(s, { type: "waiting-resolved" }, 1400);
    expect(s.activity).toBe("working");
  });

  it("防御：waiting 期间工具跑起来 ⇒ 视为已响应（granted 事件丢失也不会永久卡住）", () => {
    const s = run(S, [
      [{ type: "turn-start" }, 1000],
      [{ type: "tool-start" }, 1100],
      [{ type: "waiting" }, 1200],
      [{ type: "tool-start" }, 1300],
    ]);
    expect(s.activity).toBe("working");
  });

  it("不在 waiting 时收到 waiting-resolved 是 no-op", () => {
    const s = run(S, [[{ type: "turn-start" }, 1000]]);
    expect(reduceAgentActivity(s, { type: "waiting-resolved" }, 1100)).toBe(s);
  });
});

describe("blocked", () => {
  it("error 进 blocked，停留 BLOCKED_HOLD_MS 后自己回落（轮内回 thinking）", () => {
    let s = run(S, [
      [{ type: "turn-start" }, 1000],
      [{ type: "tool-start" }, 1100],
      [{ type: "error" }, 1200],
    ]);
    expect(s.activity).toBe("blocked");
    expect(s.blockedAt).toBe(1200);

    s = tickAgentActivity(s, 1200 + BLOCKED_HOLD_MS - 1);
    expect(s.activity).toBe("blocked");
    s = tickAgentActivity(s, 1200 + BLOCKED_HOLD_MS);
    expect(s.activity).toBe("thinking");
  });

  it("轮外来 error（无 turn-start）停留后回 idle", () => {
    let s = reduceAgentActivity(S, { type: "error" }, 500);
    s = tickAgentActivity(s, 500 + BLOCKED_HOLD_MS);
    expect(s.activity).toBe("idle");
  });

  it("blocked 期间工具跑起来 ⇒ 直接回 working（错误不该压住后续活动）", () => {
    const s = run(S, [
      [{ type: "turn-start" }, 1000],
      [{ type: "error" }, 1100],
      [{ type: "tool-start" }, 1200],
    ]);
    expect(s.activity).toBe("working");
    expect(s.blockedAt).toBeNull();
  });
});

describe("引用相等——宿主据此跳过重渲染", () => {
  it("同状态事件返回原对象", () => {
    const s = run(S, [
      [{ type: "turn-start" }, 1000],
      [{ type: "tool-start" }, 1100],
    ]);
    expect(reduceAgentActivity(s, { type: "tool-start" }, 1200)).toBe(s);
  });

  it("tick 无事可做时返回原对象", () => {
    const s = run(S, [[{ type: "turn-start" }, 1000]]);
    expect(tickAgentActivity(s, 2000)).toBe(s);
  });

  it("空转的 turn-end 返回原对象", () => {
    expect(reduceAgentActivity(S, { type: "turn-end" }, 100)).toBe(S);
  });

  it("非 working 状态收到 tool-end 是 no-op（不虚增计数）", () => {
    const s = run(S, [[{ type: "turn-start" }, 1000]]);
    expect(reduceAgentActivity(s, { type: "tool-end" }, 1100)).toBe(s);
  });
});

describe("不变量：任何脏时间戳都不产生非法输出", () => {
  const dirty = [NaN, Infinity, -Infinity, -1000, 0, 1e18];

  it("sanitizeTimestamp：非有限落回 fallback，时钟回退钳成不回退", () => {
    expect(sanitizeTimestamp(NaN, 500)).toBe(500);
    expect(sanitizeTimestamp(Infinity, 500)).toBe(500);
    expect(sanitizeTimestamp(-Infinity, 500)).toBe(500);
    expect(sanitizeTimestamp(300, 500)).toBe(500); // 回退
    expect(sanitizeTimestamp(700, 500)).toBe(700);
    expect(sanitizeTimestamp(NaN, NaN)).toBe(0); // fallback 也脏
  });

  it("所有事件配所有脏 now：activity 永远是合法值，时刻字段永不为 NaN", () => {
    const events = [
      "turn-start",
      "turn-end",
      "tool-start",
      "tool-end",
      "waiting",
      "waiting-resolved",
      "error",
    ] as const;
    for (const type of events) {
      for (const now of dirty) {
        const s = reduceAgentActivity(S, { type }, now);
        expect(["idle", "thinking", "working", "waiting", "blocked"]).toContain(s.activity);
        expect(Number.isFinite(s.activityChangedAt)).toBe(true);
        if (s.lastToolEndAt !== null) expect(Number.isFinite(s.lastToolEndAt)).toBe(true);
        if (s.blockedAt !== null) expect(Number.isFinite(s.blockedAt)).toBe(true);
        if (s.turnStartedAt !== null) expect(Number.isFinite(s.turnStartedAt)).toBe(true);

        const ticked = tickAgentActivity(s, now);
        expect(["idle", "thinking", "working", "waiting", "blocked"]).toContain(ticked.activity);
        expect(Number.isFinite(ticked.activityChangedAt)).toBe(true);
      }
    }
  });

  it("时钟回退不会把迟滞判成到期（否则会凭空切走）", () => {
    let s = run(S, [
      [{ type: "turn-start" }, 10000],
      [{ type: "tool-start" }, 10100],
      [{ type: "tool-end" }, 10200],
    ]);
    s = tickAgentActivity(s, 5000); // 时钟跳回过去
    expect(s.activity).toBe("working");
  });
});

describe("mapAgentEvent —— 真实协议名到语义事件", () => {
  it("主干事件都有映射", () => {
    expect(mapAgentEvent("agent:turn:start")).toEqual({ type: "turn-start" });
    expect(mapAgentEvent("agent:turn:end")).toEqual({ type: "turn-end" });
    expect(mapAgentEvent("agent:idle")).toEqual({ type: "turn-end" });
    expect(mapAgentEvent("agent:tool:start")).toEqual({ type: "tool-start" });
    expect(mapAgentEvent("agent:tool:end")).toEqual({ type: "tool-end" });
    expect(mapAgentEvent("agent:error")).toEqual({ type: "error" });
  });

  it("permission / ask-user 的四种收尾都算已响应", () => {
    for (const t of [
      "agent:permission:granted",
      "agent:permission:denied",
      "agent:permission:timeout",
      "agent:permission:prompt:granted",
      "agent:permission:prompt:denied",
      "agent:permission:prompt:timeout",
      "agent:permission:prompt:cancelled",
      "agent:ask-user:cancelled",
    ]) {
      expect(mapAgentEvent(t)).toEqual({ type: "waiting-resolved" });
    }
    expect(mapAgentEvent("agent:permission:request")).toEqual({ type: "waiting" });
    expect(mapAgentEvent("agent:ask-user:request")).toEqual({ type: "waiting" });
  });

  it("流式事件刻意不映射——它们不改状态，映射只会让 reducer 白跑几十万次", () => {
    expect(mapAgentEvent("agent:message:delta")).toBeNull();
    expect(mapAgentEvent("agent:thinking:delta")).toBeNull();
    expect(mapAgentEvent("agent:tool:progress")).toBeNull();
    expect(mapAgentEvent("agent:message:end")).toBeNull();
  });

  it("未知事件返回 null 而不是抛错", () => {
    expect(mapAgentEvent("")).toBeNull();
    expect(mapAgentEvent("agent:memories:list")).toBeNull();
  });
});
