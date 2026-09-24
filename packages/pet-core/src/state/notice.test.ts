import { describe, it, expect } from "vitest";
import {
  NOTICE_CAPACITY,
  NOTICE_TEXTS,
  PERMISSION_DESC_MAX,
  PET_GOAL_FAILED_FALLBACK,
  PET_GOAL_FALLBACK_TEXT,
  REPORT_PER_SESSION_MS,
  REPORT_TTL_MS,
  SENSING_TTL_MS,
  RESOLVED_KEEP_MS,
  TASK_COMPLETE_FALLBACK_TEXT,
  TURN_LONG_MS,
  noticeFromEvent,
  isQuietHour,
  pendingNotices,
  pickNoticeForBubble,
  reduceNotices,
  tickNotices,
  toolLabel,
  type NoticeEvent,
  type NoticeReportStamp,
  type PetNotice,
} from "./notice.js";
import { ANNOUNCE_THROTTLE_MS } from "./agent-activity-announce.js";

const S = "session-a";
const ctx = (now: number, windowFocused?: boolean) => ({ now, windowFocused });

/** 造一条事件（默认带会话键——绝大多数用例都要求它） */
function ev(over: Partial<NoticeEvent> & { type: string }): NoticeEvent {
  return { sessionKey: S, ...over };
}

/** 把一串 (事件, 时刻) 折成列表 */
function run(
  steps: readonly (readonly [NoticeEvent, number])[],
  start: readonly PetNotice[] = [],
): readonly PetNotice[] {
  return steps.reduce((acc, [e, at]) => reduceNotices(acc, e, ctx(at)), start);
}

describe("§四 映射表 —— 逐行", () => {
  it("task_complete 成功 → report，文案取 summary", () => {
    const n = noticeFromEvent(
      ev({ type: "agent:tool:end", toolName: "task_complete", summary: "把文档整理完了" }),
      ctx(1000),
    );
    expect(n?.level).toBe("report");
    expect(n?.kind).toBe("task-complete");
    expect(n?.text).toBe("把文档整理完了");
    expect(n?.deepLink).toEqual({ to: "session" });
    expect(n?.id.startsWith(`task:${S}:`)).toBe(true);
  });

  it("task_complete 但工具报错 → 不产生完成通知（失败的不是「做完了」）", () => {
    const list = run([
      [ev({ type: "agent:tool:end", toolName: "task_complete", isError: true, summary: "x" }), 1000],
    ]);
    expect(list.every((n) => n.kind !== "task-complete")).toBe(true);
    expect(list[0]?.level).toBe("ambient");
  });

  it("普通工具结束 → 不进表", () => {
    expect(noticeFromEvent(ev({ type: "agent:tool:end", toolName: "bash" }), ctx(1000))).toBeNull();
  });

  it("turn:end 时长 ≥ 90s → report，文案固定", () => {
    const n = noticeFromEvent(ev({ type: "agent:turn:end", durationMs: TURN_LONG_MS, turnIndex: 3 }), ctx(1000));
    expect(n?.level).toBe("report");
    expect(n?.kind).toBe("long-turn");
    expect(n?.text).toBe(NOTICE_TEXTS.longTurn);
    expect(n?.id).toBe(`turn:${S}:3`);
  });

  it("turn:end 用户发起后主窗失焦 → 也升级（补位）", () => {
    const n = noticeFromEvent(
      ev({ type: "agent:turn:end", durationMs: 5_000, turnIndex: 4, userInitiated: true }),
      ctx(1000, false),
    );
    expect(n?.level).toBe("report");
  });

  it("turn:end 有 task_complete 时让位（不补第二句）", () => {
    const n = noticeFromEvent(
      ev({ type: "agent:turn:end", durationMs: 200_000, turnIndex: 5, hasTaskComplete: true }),
      ctx(1000),
    );
    expect(n).toBeNull();
  });

  it("permission:request → action，requestId 原样进深链，带本地超时兜底", () => {
    const n = noticeFromEvent(
      ev({
        type: "agent:permission:request",
        requestId: "req-1",
        toolName: "bash",
        description: "执行命令：node -e 1+1",
        timeoutMs: 300_000,
      }),
      ctx(1000),
    );
    expect(n?.level).toBe("action");
    expect(n?.id).toBe("perm:req-1");
    expect(n?.deepLink).toEqual({ to: "permission", requestId: "req-1" });
    // description 自描述，直接用（不前缀工具中文名——实测那样会得到
    // 「执行 Shell 命令：执行命令：…」，把命令本身挤到截断之外）
    expect(n?.text).toBe("执行命令：node -e 1+1");
    expect(n?.timeoutAt).toBe(1000 + 300_000);
  });

  it("permission 没有 description 时退回工具中文名", () => {
    const n = noticeFromEvent(
      ev({ type: "agent:permission:request", requestId: "req-2", toolName: "bash" }),
      ctx(1000),
    );
    expect(n?.text).toBe("执行 Shell 命令");
    // 连工具名都没有（理论上不会）时也要有话说
    expect(
      noticeFromEvent(ev({ type: "agent:permission:request", requestId: "req-3" }), ctx(1000))?.text,
    ).toBe("有个操作");
  });

  it("**已被自动放行的不叫人**：自动审批开着时 request→granted 只隔 3ms，气泡没机会冒而系统通知已经弹了", () => {
    const n = noticeFromEvent(
      ev({
        type: "agent:permission:request",
        requestId: "req-auto",
        toolName: "bash",
        description: "执行命令：node -e 1",
        autoApproved: true,
      }),
      ctx(1000),
    );
    expect(n).toBeNull();
  });

  it("permission:prompt（渠道通道）与 request 同档同键", () => {
    const n = noticeFromEvent(
      ev({ type: "agent:permission:prompt", requestId: "req-2", toolName: "file_write" }),
      ctx(1000),
    );
    expect(n?.level).toBe("action");
    expect(n?.id).toBe("perm:req-2");
  });

  it("ask-user:request → action，深链指向去回答", () => {
    const n = noticeFromEvent(ev({ type: "agent:ask-user:request", requestId: "q-1" }), ctx(1000));
    expect(n?.level).toBe("action");
    expect(n?.deepLink).toEqual({ to: "ask-user", requestId: "q-1" });
    expect(n?.text).toBe(NOTICE_TEXTS.askUser);
  });

  it("subagent failed / stale → report；succeeded 不通知", () => {
    const failed = noticeFromEvent(
      ev({ type: "agent:subagent:completed", subagentName: "查资料", subagentStatus: "failed" }),
      ctx(1000),
    );
    expect(failed?.level).toBe("report");
    expect(failed?.text).toContain("查资料");
    expect(
      noticeFromEvent(
        ev({ type: "agent:subagent:completed", subagentName: "查资料", subagentStatus: "succeeded" }),
        ctx(1000),
      ),
    ).toBeNull();
  });

  it("agent:error 可重试 → ambient；不可重试 → report", () => {
    const soft = noticeFromEvent(
      ev({ type: "agent:error", errorCode: "timeout", isRetryable: true }),
      ctx(1000),
    );
    expect(soft?.level).toBe("ambient");
    const hard = noticeFromEvent(
      ev({ type: "agent:error", errorCode: "auth", isRetryable: false }),
      ctx(1000),
    );
    expect(hard?.level).toBe("report");
    expect(hard?.deepLink).toEqual({ to: "session" });
  });

  it("abort：用户自己按的停止 → ambient；超时 → report", () => {
    expect(noticeFromEvent(ev({ type: "agent:abort", reason: "user_cancel" }), ctx(1000))?.level).toBe(
      "ambient",
    );
    expect(noticeFromEvent(ev({ type: "agent:abort", reason: "timeout" }), ctx(1000))?.level).toBe(
      "report",
    );
  });

  it("file-changes 只在「主窗失焦且用户没参与」时补一句", () => {
    const base = { type: "agent:turn:file-changes" as const, fileCount: 3, turnIndex: 7 };
    expect(noticeFromEvent(ev(base), ctx(1000, false))?.text).toBe("改了 3 个文件");
    expect(noticeFromEvent(ev(base), ctx(1000, true))).toBeNull();
    expect(noticeFromEvent(ev({ ...base, userInitiated: true }), ctx(1000, false))).toBeNull();
    expect(noticeFromEvent(ev({ ...base, fileCount: 0 }), ctx(1000, false))).toBeNull();
  });

  it("过程事件一律不进表", () => {
    for (const type of [
      "agent:message:delta",
      "agent:thinking:delta",
      "agent:tool:start",
      "agent:tool:progress",
      "agent:context:compacted",
      "agent:turn:start",
    ]) {
      expect(noticeFromEvent(ev({ type }), ctx(1000))).toBeNull();
    }
  });

  it("映射表每行都有非空的 id / text", () => {
    const rows: NoticeEvent[] = [
      ev({ type: "agent:tool:end", toolName: "task_complete", summary: "s" }),
      ev({ type: "agent:turn:end", durationMs: TURN_LONG_MS }),
      ev({ type: "agent:permission:request", requestId: "r", toolName: "bash" }),
      ev({ type: "agent:ask-user:request", requestId: "q" }),
      ev({ type: "agent:subagent:completed", subagentName: "n", subagentStatus: "stale" }),
      ev({ type: "agent:error", errorCode: "e", isRetryable: false }),
      ev({ type: "agent:turn:file-changes", fileCount: 1 }),
      ev({ type: "pet:goal:result", summary: "看过了", ok: true }),
      ev({ type: "pet:sensing", summary: "要不要歇会儿" }),
    ];
    for (const e of rows) {
      const n = noticeFromEvent(e, ctx(1000, false));
      expect(n, e.type).not.toBeNull();
      expect(n!.id.length, e.type).toBeGreaterThan(0);
      expect(n!.text.length, e.type).toBeGreaterThan(0);
    }
  });

  it("宠物目标回执 → report，文案就是宠物报的原话", () => {
    const n = noticeFromEvent(
      ev({ type: "pet:goal:result", summary: "工作目录根下有这些：a、b、c", ok: true }),
      ctx(1000),
    );
    expect(n?.kind).toBe("pet-goal");
    expect(n?.level).toBe("report");
    expect(n?.text).toBe("工作目录根下有这些：a、b、c");
    // 与 task-complete 分开的幂等前缀：两种通知不该互相顶掉
    expect(n?.id.startsWith(`petgoal:${S}:`)).toBe(true);
    expect(n?.ttlMs).toBe(REPORT_TTL_MS);
  });

  it("宠物没做成 → 前缀把「没成」摆在最前面（不许含糊过去）", () => {
    const withBody = noticeFromEvent(
      ev({ type: "pet:goal:result", summary: "那个目录读不到", ok: false }),
      ctx(1000),
    );
    expect(withBody?.text).toBe("没能做成：那个目录读不到");
    // 连话都没说
    const silent = noticeFromEvent(ev({ type: "pet:goal:result", ok: false }), ctx(1000));
    expect(silent?.text).toBe(PET_GOAL_FAILED_FALLBACK);
    // 成功但没话说的兜底是**另一句**——失败说成"我去看过了"就是撒谎
    const okSilent = noticeFromEvent(ev({ type: "pet:goal:result", ok: true }), ctx(1000));
    expect(okSilent?.text).toBe(PET_GOAL_FALLBACK_TEXT);
    expect(okSilent?.text).not.toBe(PET_GOAL_FAILED_FALLBACK);
  });

  it("ok 缺省按成功算：旧发送方不带这个字段，不因此被报成失败", () => {
    const n = noticeFromEvent(ev({ type: "pet:goal:result", summary: "看过了" }), ctx(1000));
    expect(n?.text).toBe("看过了");
  });

  it("宠物感知到的一句话 → report，文案就是那句原话", () => {
    const n = noticeFromEvent(ev({ type: "pet:sensing", summary: "要不要歇会儿" }), ctx(1000));
    expect(n?.kind).toBe("pet-sensing");
    expect(n?.level).toBe("report");
    expect(n?.text).toBe("要不要歇会儿");
    // 与目标回执分开的幂等前缀
    expect(n?.id.startsWith(`sensing:${S}:`)).toBe(true);
  });

  it("**TTL 比 report 长**：它要排过一次会话闸门才轮得到冒泡（真机踩过这个坑）", () => {
    const n = noticeFromEvent(ev({ type: "pet:sensing", summary: "要不要歇会儿" }), ctx(1000));
    expect(n?.ttlMs).toBe(SENSING_TTL_MS);
    // 30 秒的 TTL 撑不过 60 秒的会话闸门——那条通知会"既没冒泡、配额又花掉"
    expect(SENSING_TTL_MS).toBeGreaterThanOrEqual(REPORT_PER_SESSION_MS);
  });

  it("**没有内容就整条不产生**——与目标回执正好相反", () => {
    // 感知类属于"说了没听见就算了"那一类（设计 §4.2.2）；用户交代过的事才必须能回来看到，
    // 所以 pet:goal:result 空文案时用兜底句，这里直接丢
    expect(noticeFromEvent(ev({ type: "pet:sensing" }), ctx(1000))).toBeNull();
    expect(noticeFromEvent(ev({ type: "pet:sensing", summary: "   " }), ctx(1000))).toBeNull();
  });

  it("同上：没有会话键 → null（感知的话也得有落点，否则点了不知道跳哪）", () => {
    expect(
      noticeFromEvent({ type: "pet:sensing", summary: "要不要歇会儿" }, ctx(1000)),
    ).toBeNull();
  });

  it("同类两条不同的话不会互相顶掉（幂等键带文案哈希）", () => {
    const a = noticeFromEvent(ev({ type: "pet:sensing", summary: "要不要歇会儿" }), ctx(1000));
    const b = noticeFromEvent(ev({ type: "pet:sensing", summary: "起来走两步？" }), ctx(1000));
    expect(a?.id).not.toBe(b?.id);
  });
});

describe("§十.1 不变量 —— 缺字段返回 null，不造残缺通知", () => {
  it("没有会话键 → null", () => {
    const withoutSession = (e: NoticeEvent): NoticeEvent => ({ ...e, sessionKey: undefined });
    for (const e of [
      { type: "agent:tool:end", toolName: "task_complete", summary: "s" },
      { type: "agent:turn:end", durationMs: TURN_LONG_MS },
      { type: "agent:permission:request", requestId: "r", toolName: "bash" },
      { type: "agent:ask-user:request", requestId: "q" },
      { type: "agent:error", errorCode: "e" },
      { type: "agent:turn:file-changes", fileCount: 1 },
    ]) {
      expect(noticeFromEvent(withoutSession(e as NoticeEvent), ctx(1000, false)), e.type).toBeNull();
    }
  });

  it("空串 / 全空白的会话键同样算缺", () => {
    expect(noticeFromEvent(ev({ type: "agent:ask-user:request", requestId: "q", sessionKey: "  " }), ctx(1000))).toBeNull();
  });

  it("permission 缺 requestId → null（点了也没法去审批）", () => {
    expect(noticeFromEvent(ev({ type: "agent:permission:request", toolName: "bash" }), ctx(1000))).toBeNull();
  });

  it("ask-user 缺 requestId → null", () => {
    expect(noticeFromEvent(ev({ type: "agent:ask-user:request" }), ctx(1000))).toBeNull();
  });

  it("task_complete 缺 summary 不算残缺 —— 有会话可跳，用兜底文案", () => {
    const n = noticeFromEvent(ev({ type: "agent:tool:end", toolName: "task_complete" }), ctx(1000));
    expect(n?.text).toBe(TASK_COMPLETE_FALLBACK_TEXT);
    expect(n?.deepLink).toEqual({ to: "session" });
  });
});

describe("§十.1 幂等 —— 事件重放不叫第二遍", () => {
  it("同一条 permission:request 连发 3 次 → 只有 1 条", () => {
    const e = ev({ type: "agent:permission:request", requestId: "req-1", toolName: "bash" });
    const list = run([
      [e, 1000],
      [e, 1200],
      [e, 1500],
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("perm:req-1");
  });

  it("宠物窗口重载（同一条重放）后仍只有 1 条 —— 已销账的条目也挡着", () => {
    const e = ev({ type: "agent:permission:request", requestId: "req-1", toolName: "bash" });
    let list = run([[e, 1000]]);
    list = reduceNotices(list, ev({ type: "agent:permission:granted", requestId: "req-1" }), ctx(2000));
    expect(list[0]!.resolution).toBe("granted");
    list = reduceNotices(list, e, ctx(3000));
    expect(list).toHaveLength(1);
  });

  it("不同 requestId 各产生一条", () => {
    const list = run([
      [ev({ type: "agent:permission:request", requestId: "r1" }), 1000],
      [ev({ type: "agent:permission:request", requestId: "r2" }), 1100],
    ]);
    expect(list).toHaveLength(2);
  });
});

describe("§十.1 销账 —— 只认事件，不因 UI 状态变化", () => {
  const opened = (): readonly PetNotice[] =>
    run([
      [ev({ type: "agent:permission:request", requestId: "req-1", toolName: "bash" }), 1000],
      [ev({ type: "agent:ask-user:request", requestId: "q-1" }), 1100],
    ]);

  it("granted / denied / timeout / cancelled（含 :prompt: 变体）都能销账", () => {
    const cases: readonly [string, string][] = [
      ["agent:permission:granted", "granted"],
      ["agent:permission:denied", "denied"],
      ["agent:permission:timeout", "timeout"],
      ["agent:permission:prompt:granted", "granted"],
      ["agent:permission:prompt:denied", "denied"],
      ["agent:permission:prompt:timeout", "timeout"],
      ["agent:permission:prompt:cancelled", "cancelled"],
    ];
    for (const [type, outcome] of cases) {
      const list = reduceNotices(opened(), ev({ type, requestId: "req-1" }), ctx(2000));
      const perm = list.find((n) => n.id === "perm:req-1")!;
      expect(perm.resolution, type).toBe(outcome);
      expect(perm.resolvedAt, type).toBe(2000);
      // 销账 ≠ 删除：控制坞要能显示「已超时被拒」
      expect(list.find((n) => n.id === "ask:q-1")!.resolvedAt).toBeUndefined();
    }
  });

  it("ask-user:cancelled 按 requestId 销账，且不动别人的账", () => {
    const list = reduceNotices(opened(), ev({ type: "agent:ask-user:cancelled", requestId: "q-1" }), ctx(2000));
    expect(list.find((n) => n.id === "ask:q-1")!.resolution).toBe("cancelled");
    expect(list.find((n) => n.id === "perm:req-1")!.resolvedAt).toBeUndefined();
  });

  it("无关的 requestId 不误伤", () => {
    const list = reduceNotices(opened(), ev({ type: "agent:permission:granted", requestId: "other" }), ctx(2000));
    expect(list.every((n) => n.resolvedAt === undefined)).toBe(true);
  });

  it("permission 的解除事件不销 ask-user 的账（即使 requestId 撞了）", () => {
    const list = run([
      [ev({ type: "agent:ask-user:request", requestId: "same" }), 1000],
      [ev({ type: "agent:permission:request", requestId: "same", toolName: "bash" }), 1000],
    ]);
    const after = reduceNotices(
      list,
      ev({ type: "agent:permission:granted", requestId: "same" }),
      ctx(2000),
    );
    expect(after.find((n) => n.id === "perm:same")!.resolution).toBe("granted");
    expect(after.find((n) => n.id === "ask:same")!.resolvedAt).toBeUndefined();
  });

  it("**不因 activity 变化而消失**：随后来的过程事件不销账", () => {
    let list = opened();
    for (const [type, at] of [
      ["agent:tool:start", 1500],
      ["agent:tool:end", 1600],
      ["agent:turn:end", 1700],
      ["agent:message:delta", 1800],
    ] as const) {
      list = reduceNotices(list, ev({ type }), ctx(at));
    }
    expect(list.find((n) => n.id === "perm:req-1")!.resolvedAt).toBeUndefined();
  });

  it("已销账的不被后来的解除事件覆盖（先到的事件说了算）", () => {
    let list = reduceNotices(opened(), ev({ type: "agent:permission:denied", requestId: "req-1" }), ctx(2000));
    list = reduceNotices(list, ev({ type: "agent:permission:granted", requestId: "req-1" }), ctx(2500));
    expect(list.find((n) => n.id === "perm:req-1")!.resolution).toBe("denied");
    expect(list.find((n) => n.id === "perm:req-1")!.resolvedAt).toBe(2000);
  });
});

describe("§十.1 超时 —— 本地兜底把 action 标为已超时", () => {
  const withTimeout = (): readonly PetNotice[] =>
    run([
      [
        ev({ type: "agent:permission:request", requestId: "req-1", toolName: "bash", timeoutMs: 300_000 }),
        1000,
      ],
    ]);

  it("到点标为 timeout，而不是被删掉", () => {
    const before = tickNotices(withTimeout(), 1000 + 300_000 - 1);
    expect(before[0]!.resolvedAt).toBeUndefined();
    const after = tickNotices(withTimeout(), 1000 + 300_000);
    expect(after).toHaveLength(1);
    expect(after[0]!.resolution).toBe("timeout");
    expect(after[0]!.resolvedAt).toBe(1000 + 300_000);
  });

  it("没有 timeoutMs 的 action（ask-user）不参与超时", () => {
    const ask = run([[ev({ type: "agent:ask-user:request", requestId: "q-1" }), 1000]]);
    expect(tickNotices(ask, 10_000_000)[0]!.resolvedAt).toBeUndefined();
  });
});

describe("§三 TTL —— report 30 秒自清，action 一直挂着", () => {
  it("report 到点从列表消失", () => {
    const list = run([
      [ev({ type: "agent:tool:end", toolName: "task_complete", summary: "做完" }), 1000],
    ]);
    expect(tickNotices(list, 1000 + REPORT_TTL_MS - 1)).toHaveLength(1);
    expect(tickNotices(list, 1000 + REPORT_TTL_MS)).toHaveLength(0);
  });

  it("action 不因时间流逝消失（等处置）", () => {
    const list = run([[ev({ type: "agent:permission:request", requestId: "r" }), 1000]]);
    expect(tickNotices(list, 1000 + 10 * REPORT_TTL_MS)).toHaveLength(1);
  });

  it("已销账条目留 RESOLVED_KEEP_MS 再清", () => {
    let list = run([[ev({ type: "agent:permission:request", requestId: "r" }), 1000]]);
    list = reduceNotices(list, ev({ type: "agent:permission:granted", requestId: "r" }), ctx(2000));
    expect(tickNotices(list, 2000 + RESOLVED_KEEP_MS - 1)).toHaveLength(1);
    expect(tickNotices(list, 2000 + RESOLVED_KEEP_MS)).toHaveLength(0);
  });

  it("无变化时返回原数组（引用不变）", () => {
    const list = run([[ev({ type: "agent:permission:request", requestId: "r" }), 1000]]);
    expect(tickNotices(list, 1500)).toBe(list);
    expect(reduceNotices(list, ev({ type: "agent:message:delta" }), ctx(1500))).toBe(list);
  });
});

describe("§6.1 容量 —— 200 条上限，只淘汰已销账的", () => {
  it("第 201 条挤掉最老的已销账条目", () => {
    let list: readonly PetNotice[] = [];
    for (let i = 0; i < NOTICE_CAPACITY; i++) {
      list = reduceNotices(list, ev({ type: "agent:permission:request", requestId: `r${i}` }), ctx(1000 + i));
      list = reduceNotices(list, ev({ type: "agent:permission:granted", requestId: `r${i}` }), ctx(1000 + i));
    }
    expect(list).toHaveLength(NOTICE_CAPACITY);
    list = reduceNotices(list, ev({ type: "agent:permission:request", requestId: "new" }), ctx(9999));
    expect(list.some((n) => n.id === "perm:r0")).toBe(false);
    expect(list.some((n) => n.id === "perm:new")).toBe(true);
  });

  it("全是未销账的 action 时不淘汰任何人（都得挂着）", () => {
    let list: readonly PetNotice[] = [];
    for (let i = 0; i <= NOTICE_CAPACITY; i++) {
      list = reduceNotices(list, ev({ type: "agent:permission:request", requestId: `r${i}` }), ctx(1000 + i));
    }
    expect(list).toHaveLength(NOTICE_CAPACITY + 1);
  });
});

describe("§7 气泡挑选 —— 排序与抢占", () => {
  const perm = (requestId: string, at: number, sessionKey = S): readonly [NoticeEvent, number] => [
    ev({ type: "agent:permission:request", requestId, toolName: "bash", sessionKey }),
    at,
  ];
  const done = (summary: string, at: number, sessionKey = S): readonly [NoticeEvent, number] => [
    ev({ type: "agent:tool:end", toolName: "task_complete", summary, sessionKey }),
    at,
  ];

  it("action 抢占 report", () => {
    const list = run([done("干完了", 1000), perm("r1", 1100)]);
    expect(pickNoticeForBubble(list, 1200)?.id).toBe("perm:r1");
  });

  it("跨会话按到达时间，不按主体会话优先", () => {
    const list = run([
      perm("later", 2000, "session-b"),
      perm("earlier", 1000, "session-a"),
    ]);
    expect(pickNoticeForBubble(list, 2100)?.id).toBe("perm:earlier");
  });

  it("同一会话多条 action → 取最新那条", () => {
    const list = run([perm("old", 1000), perm("new", 1500)]);
    expect(pickNoticeForBubble(list, 1600)?.id).toBe("perm:new");
  });

  it("report 按时间先到先冒", () => {
    const list = run([done("第二件", 2000), done("第一件", 1000)]);
    expect(pickNoticeForBubble(list, 2100)?.text).toBe("第一件");
  });

  it("已销账的不再冒", () => {
    let list = run([perm("r1", 1000)]);
    expect(pickNoticeForBubble(list, 1100)?.id).toBe("perm:r1");
    list = reduceNotices(list, ev({ type: "agent:permission:granted", requestId: "r1" }), ctx(1200));
    expect(pickNoticeForBubble(list, 1300)).toBeNull();
  });

  it("ambient 永不冒", () => {
    const list = run([[ev({ type: "agent:abort", reason: "user_cancel" }), 1000]]);
    expect(pickNoticeForBubble(list, 1100)).toBeNull();
  });

  it("已冒过（announcedIds）的不再冒 —— 宠物窗口重载后的幂等", () => {
    const list = run([perm("r1", 1000)]);
    expect(pickNoticeForBubble(list, 1100, { announcedIds: new Set() })?.id).toBe("perm:r1");
    expect(pickNoticeForBubble(list, 1100, { announcedIds: new Set(["perm:r1"]) })).toBeNull();
    // action 不受预算限制，但幂等仍然管着它
  });
});

describe("§6.2 report 预算 —— 每会话 1/分钟、全局 3/分钟、同文案 10 分钟", () => {
  const done = (summary: string, at: number, sessionKey = S): readonly [NoticeEvent, number] => [
    ev({ type: "agent:tool:end", toolName: "task_complete", summary, sessionKey }),
    at,
  ];

  it("同会话 1 分钟内只冒一条", () => {
    const list = run([done("A", 1000), done("B", 2000)]);
    // A 已经冒过 → 同会话的 B 在窗口内也被压住（限额是**每会话**的，不是每条通知的）
    const recent: NoticeReportStamp[] = [{ sessionKey: S, at: 1000 }];
    expect(pickNoticeForBubble(list, 2000, { recentReports: recent })).toBeNull();
    // 过了窗口就放行
    expect(
      pickNoticeForBubble(list, 1000 + REPORT_PER_SESSION_MS, { recentReports: recent })?.text,
    ).toBe("A");
  });

  it("全局限 3 条/分钟（跨会话也一样）", () => {
    const list = run([
      done("a", 1000, "s1"),
      done("b", 1100, "s2"),
      done("c", 1200, "s3"),
      done("d", 1300, "s4"),
    ]);
    const recent: NoticeReportStamp[] = [
      { sessionKey: "s1", at: 1000 },
      { sessionKey: "s2", at: 1100 },
      { sessionKey: "s3", at: 1200 },
    ];
    expect(pickNoticeForBubble(list, 1300, { recentReports: recent })).toBeNull();
    // 过了窗口就放行
    expect(pickNoticeForBubble(list, 1200 + REPORT_PER_SESSION_MS, { recentReports: recent })?.text).toBe("a");
  });

  it("同文案 10 分钟内不重复（跨轮次也压住）", () => {
    const list = run([[ev({ type: "agent:turn:end", durationMs: TURN_LONG_MS, turnIndex: 1 }), 1000]]);
    const lastShownTextAt = new Map([[NOTICE_TEXTS.longTurn, 1000]]);
    expect(
      pickNoticeForBubble(list, 1000 + ANNOUNCE_THROTTLE_MS - 1, { lastShownTextAt }),
    ).toBeNull();
    expect(pickNoticeForBubble(list, 1000 + ANNOUNCE_THROTTLE_MS, { lastShownTextAt })?.text).toBe(
      NOTICE_TEXTS.longTurn,
    );
  });
});

describe("§6.3 / §九 仲裁 —— 免打扰、拖拽、对话中", () => {
  const both = () =>
    run([
      [ev({ type: "agent:tool:end", toolName: "task_complete", summary: "干完了" }), 1000],
      [ev({ type: "agent:permission:request", requestId: "r1", toolName: "bash" }), 1100],
    ]);

  it("免打扰：report 吞掉、action 也不冒气泡（降级为符号 + 控制坞 + 系统通知）", () => {
    expect(pickNoticeForBubble(both(), 1200, { quietHours: true })).toBeNull();
  });

  it("拖拽中：气泡一律不弹", () => {
    expect(pickNoticeForBubble(both(), 1200, { beingDragged: true })).toBeNull();
  });

  it("对话中：report 推迟，action 插队", () => {
    const talks = { talkingWithUser: true };
    const onlyReport = run([
      [ev({ type: "agent:tool:end", toolName: "task_complete", summary: "干完了" }), 1000],
    ]);
    expect(pickNoticeForBubble(onlyReport, 1200, talks)).toBeNull();
    expect(pickNoticeForBubble(both(), 1200, talks)?.id).toBe("perm:r1");
  });
});

describe("pendingNotices —— 控制坞的清单", () => {
  it("action 在前、按时间升序；已销账与 ambient 不列", () => {
    let list = run([
      [ev({ type: "agent:tool:end", toolName: "task_complete", summary: "干完了" }), 1000],
      [ev({ type: "agent:permission:request", requestId: "r2" }), 1200],
      [ev({ type: "agent:permission:request", requestId: "r1" }), 1100],
      [ev({ type: "agent:abort", reason: "user_cancel" }), 1300],
    ]);
    const ids = pendingNotices(list).map((n) => n.id);
    expect(ids[0]).toBe("perm:r1");
    expect(ids[1]).toBe("perm:r2");
    // report 排在 action 后面（幂等键里带摘要哈希，只断言前缀）
    expect(ids[2]!.startsWith(`task:${S}:`)).toBe(true);

    list = reduceNotices(list, ev({ type: "agent:permission:granted", requestId: "r1" }), ctx(1400));
    const after = pendingNotices(list).map((n) => n.id);
    expect(after).toContain("perm:r2");
    expect(after).not.toContain("perm:r1");
  });
});

describe("isQuietHour —— 免打扰窗口（与主动联系共用同一个）", () => {
  it("跨午夜：22:00 起、08:00 止", () => {
    for (const h of [22, 23, 0, 3, 7]) expect(isQuietHour(h), `${h} 点`).toBe(true)
    // 08:00 整点**不算**（区间是左闭右开），与 local-companion-handler 的原实现一致
    for (const h of [8, 12, 18, 21]) expect(isQuietHour(h), `${h} 点`).toBe(false)
  })

  it("不跨午夜时按普通区间判（左闭右开）", () => {
    expect(isQuietHour(1, 1, 5)).toBe(true)
    expect(isQuietHour(4, 1, 5)).toBe(true)
    expect(isQuietHour(5, 1, 5)).toBe(false)
    expect(isQuietHour(0, 1, 5)).toBe(false)
  })

  it("start === end 视为「不启用」而不是「全天免打扰」", () => {
    expect(isQuietHour(3, 5, 5)).toBe(false)
    expect(isQuietHour(5, 5, 5)).toBe(false)
  })

  it("越界/非法小时不抛，按 24 取模", () => {
    expect(isQuietHour(25)).toBe(isQuietHour(1))
    expect(isQuietHour(-1)).toBe(isQuietHour(23))
    expect(isQuietHour(Number.NaN)).toBe(false)
  })
})

describe("toolLabel", () => {
  it("内置工具取中文短语；MCP 拆开显示；未知工具兜底", () => {
    expect(toolLabel("bash")).toBe("执行 Shell 命令");
    expect(toolLabel("mcp__filesystem__read_file")).toBe("MCP filesystem · read_file");
    expect(toolLabel("something_new")).toBe("执行工具 something_new");
  });

  it("很长的 description 会被截断（气泡两百来像素宽）", () => {
    const long = "删".repeat(80);
    const n = noticeFromEvent(
      ev({ type: "agent:permission:request", requestId: "r", toolName: "bash", description: long }),
      ctx(1000),
    );
    expect([...n!.text].length).toBeLessThanOrEqual(PERMISSION_DESC_MAX);
    expect(n!.text.endsWith("…")).toBe(true);
  });
});
