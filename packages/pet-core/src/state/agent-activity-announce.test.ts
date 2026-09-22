import { describe, it, expect } from "vitest";
import {
  ANNOUNCE_KEYS,
  ANNOUNCE_TEXTS,
  ANNOUNCE_THROTTLE_MS,
  WORK_LONG_MS,
  WORK_MANY_TOOLS,
  announceDurationMs,
  pickAgentAnnouncement,
} from "./agent-activity-announce.js";
import {
  initialAgentActivity,
  reduceAgentActivity,
  type AgentActivityState,
} from "./agent-activity.js";

/** 把一串 (事件, 时刻) 喂进去得到末态 */
function run(
  steps: readonly (readonly [Parameters<typeof reduceAgentActivity>[1], number])[],
): AgentActivityState {
  return steps.reduce((acc, [ev, at]) => reduceAgentActivity(acc, ev, at), initialAgentActivity);
}

const NO_HISTORY = new Map<string, number>();
const NO_TURN = new Set<string>();

describe("waiting —— 唯一值得强打扰的那个", () => {
  it("一进 waiting 就冒", () => {
    // 实测 waiting 常常只存在 0ms（waiting 与紧随的 tool-start 打在同一毫秒），
    // 所以"进 waiting 的那一刻就要能挑出来"，不能等它稳定下来
    const s = run([
      [{ type: "turn-start" }, 1000],
      [{ type: "waiting" }, 2000],
    ]);
    expect(s.activity).toBe("waiting");
    expect(pickAgentAnnouncement(s, 2000, NO_HISTORY, NO_TURN)).toEqual({
      key: ANNOUNCE_KEYS.waiting,
      text: ANNOUNCE_TEXTS.waiting,
    });
  });

  it("10 分钟节流对 waiting 同样生效（否则长任务里会反复弹）", () => {
    const s = run([
      [{ type: "turn-start" }, 1000],
      [{ type: "waiting" }, 2000],
    ]);
    const history = new Map([[ANNOUNCE_KEYS.waiting, 2000]]);
    expect(pickAgentAnnouncement(s, 2000 + ANNOUNCE_THROTTLE_MS - 1, history, NO_TURN)).toBeNull();
    expect(pickAgentAnnouncement(s, 2000 + ANNOUNCE_THROTTLE_MS, history, NO_TURN)).not.toBeNull();
  });

  it("**不受**「本轮只冒一次」限制——长任务里问两次也值得第二次叫回来", () => {
    const s = run([
      [{ type: "turn-start" }, 1000],
      [{ type: "waiting" }, 2000],
    ]);
    const shownThisTurn = new Set([ANNOUNCE_KEYS.waiting]);
    expect(pickAgentAnnouncement(s, 999_999, NO_HISTORY, shownThisTurn)).not.toBeNull();
  });
});

describe("blocked", () => {
  it("冒一次，本轮内不重复", () => {
    const s = run([
      [{ type: "turn-start" }, 1000],
      [{ type: "error" }, 2000],
    ]);
    expect(pickAgentAnnouncement(s, 2000, NO_HISTORY, NO_TURN)?.key).toBe(ANNOUNCE_KEYS.blocked);
    // 同一个 blocked 状态被反复 tick 时，靠"本轮已冒"挡住复读
    expect(
      pickAgentAnnouncement(s, 2100, NO_HISTORY, new Set([ANNOUNCE_KEYS.blocked])),
    ).toBeNull();
  });
});

describe("working —— 默认安静，忙过头才吭声", () => {
  const workingAt = (at: number, tools = 0): AgentActivityState => {
    let s = run([[{ type: "turn-start" }, 1000]]);
    for (let i = 0; i < tools; i++) {
      s = reduceAgentActivity(s, { type: "tool-start" }, at - 2);
      s = reduceAgentActivity(s, { type: "tool-end" }, at - 1);
    }
    return reduceAgentActivity(s, { type: "tool-start" }, at);
  };

  it("刚开工时不冒", () => {
    expect(pickAgentAnnouncement(workingAt(2000), 2000, NO_HISTORY, NO_TURN)).toBeNull();
  });

  it("连续工作满 WORK_LONG_MS 冒一次", () => {
    const s = workingAt(2000);
    expect(pickAgentAnnouncement(s, 1000 + WORK_LONG_MS - 1, NO_HISTORY, NO_TURN)).toBeNull();
    expect(pickAgentAnnouncement(s, 1000 + WORK_LONG_MS, NO_HISTORY, NO_TURN)?.key).toBe(
      ANNOUNCE_KEYS.workingLong,
    );
  });

  it("工具数超 WORK_MANY_TOOLS 也冒（碎任务里总时长短，但工具涨得快）", () => {
    const s = workingAt(2000, WORK_MANY_TOOLS + 1);
    expect(s.toolCount).toBe(WORK_MANY_TOOLS + 1);
    // 只过了 1 秒，远没到"忙很久"，但工具数够多
    expect(pickAgentAnnouncement(s, 3000, NO_HISTORY, NO_TURN)?.key).toBe(ANNOUNCE_KEYS.workingLong);
  });

  it("刚好等于阈值不算（边界取 >，不取 >=）", () => {
    const s = workingAt(2000, WORK_MANY_TOOLS);
    expect(s.toolCount).toBe(WORK_MANY_TOOLS);
    expect(pickAgentAnnouncement(s, 3000, NO_HISTORY, NO_TURN)).toBeNull();
  });

  it("同一轮内只冒一次——连冒三次「还在忙…」等于没说", () => {
    const s = workingAt(2000, WORK_MANY_TOOLS + 1);
    expect(
      pickAgentAnnouncement(s, 3000, NO_HISTORY, new Set([ANNOUNCE_KEYS.workingLong])),
    ).toBeNull();
  });
});

describe("idle / thinking —— 不冒", () => {
  it("idle 无话可说", () => {
    expect(pickAgentAnnouncement(initialAgentActivity, 999999, NO_HISTORY, NO_TURN)).toBeNull();
  });

  it("thinking 是「还没开始忙」，也不冒", () => {
    const s = run([[{ type: "turn-start" }, 1000]]);
    expect(s.activity).toBe("thinking");
    expect(pickAgentAnnouncement(s, 999999, NO_HISTORY, NO_TURN)).toBeNull();
  });
});

describe("announceDurationMs", () => {
  it("四字短语与长句都落在 [2600, 6000] 内", () => {
    for (const t of ["还在忙…", "需要你确认一下", "出错了", "一".repeat(80)]) {
      const d = announceDurationMs(t);
      expect(d).toBeGreaterThanOrEqual(2600);
      expect(d).toBeLessThanOrEqual(6000);
    }
  });

  it("越长停越久（单调不减）", () => {
    expect(announceDurationMs("还在忙…")).toBeLessThanOrEqual(announceDurationMs("需要你确认一下"));
  });

  it("按字符数算，不按 UTF-16 码元（emoji / 生僻字别被算成两个）", () => {
    expect(announceDurationMs("🀄🀄🀄🀄")).toBe(announceDurationMs("一二三四"));
  });
});
