/**
 * agent-activity —— Agent 活动状态（纯函数 reducer）
 *
 * 回答的问题是「**Agent 在干活吗**」，与 `PetState`（「宠物在跟用户对话吗」）
 * 是**正交维度**，不是同一件事的细分。一轮对话里两者交替出现：`turn:start` 之后
 * 对话链路还沉默着，工具阶段由本模块表达；正文 delta 一到才交给口型链路。
 *
 * 设计：docs/design/客户端UI/2026-09-21-Agent状态可见化设计.md
 *
 * ## 为什么要有「工具段」这个概念（本模块唯一的非常规设计）
 *
 * 实测（2026-09-21 当日 205 个 turn 全量统计）：**单个**工具 87% 在 200ms 内跑完，
 * 工具与工具之间只隔 2–12ms；而**整个工具阶段** p50 = 6s / p90 = 102s。
 *
 * 所以「每个 `tool:end` 就切回 thinking」会得到一条每秒抖几十次的状态线，
 * 调制层即使有 600ms 平滑也救不回来。正确做法是**按段切**：把连续的工具调用
 * 视为一个工作段，段内不切换，段结束靠 {@link WORK_SEGMENT_GAP_MS} 的迟滞判定。
 * 迟滞窗口比真实的段内间隔（2–12ms）大一个数量级，不会误切；而「模型重新思考
 * 了 5 秒才调下一个工具」会被正确地切成 thinking——那 5 秒确实是在思考。
 *
 * 迟滞需要时间流逝，而纯函数没有定时器，所以拆成两个入口：
 * {@link reduceAgentActivity}（事件驱动）+ {@link tickAgentActivity}（时间驱动，
 * 由宿主在渲染循环里每帧喂 `now`）。
 *
 * ## 命名
 *
 * 本模块的一切都叫 `agentActivity` 而不是 `activity`——`activity` 已被 R9 自主行为
 * 占用（`AmbientActivity`、`PetWanderDriver.getActivity()`、`PetOrchestrator.ambientActivity`）。
 * 两者也确实是不同的东西：那个是「宠物自己溜达到哪一步」，这个是「Agent 在做什么」。
 */

/** Agent 在做什么。刻意只有五档——细分会让表达失真（「在读文件」与「在跑命令」对用户是同一件事：它在忙）。 */
export type AgentActivity = "idle" | "thinking" | "working" | "waiting" | "blocked";

/**
 * 语义事件。
 *
 * 真实事件名（`agent:tool:start` 之类）由 {@link mapAgentEvent} 翻译，
 * **本模块不认识协议字符串**——那是 app 层的事，pet-core 保持零依赖。
 */
export type AgentActivityEventType =
  | "turn-start"
  | "turn-end"
  | "tool-start"
  | "tool-end"
  | "waiting"
  | "waiting-resolved"
  | "error";

export interface AgentActivityEvent {
  readonly type: AgentActivityEventType;
}

export interface AgentActivityState {
  readonly activity: AgentActivity;
  /** 上一个 activity 与切换时刻：**仅供调制层做平滑插值**，状态机自身不读这两个字段 */
  readonly previousActivity: AgentActivity;
  readonly activityChangedAt: number;
  /** 本轮开始时刻；null = 不在轮内 */
  readonly turnStartedAt: number | null;
  /** 本轮累计工具数——表达强度的输入之一 */
  readonly toolCount: number;
  /** 最后一个工具结束的时刻；null = 当前段内还没有工具结束过（或新工具已开始） */
  readonly lastToolEndAt: number | null;
  /** 进入 blocked 的时刻 */
  readonly blockedAt: number | null;
  /** waiting 之前的状态——用户响应后回到这里 */
  readonly resumeTo: AgentActivity;
}

/**
 * 工具段迟滞：最后一个工具结束后，静默这么久才算「这一工作段结束」。
 *
 * 200ms 的取法：实测段内间隔 2–12ms（取一个数量级余量），而 p50 的整段是 6s
 * （远大于它，所以正常的多工具段不会被腰斩）。
 */
export const WORK_SEGMENT_GAP_MS = 200;

/** blocked 停留时长。到点自动回落到 thinking/idle——错误不该永久挂在脸上。 */
export const BLOCKED_HOLD_MS = 3000;

export const initialAgentActivity: AgentActivityState = Object.freeze({
  activity: "idle",
  previousActivity: "idle",
  activityChangedAt: 0,
  turnStartedAt: null,
  toolCount: 0,
  lastToolEndAt: null,
  blockedAt: null,
  resumeTo: "idle",
});

/**
 * 时间戳净化：非有限数（NaN/Infinity）落回 `fallback`，时钟回退也钳成不回退。
 *
 * 宿主喂进来的 `now` 来自 `performance.now()` / `Date.now()`，两者都可能在
 * 休眠唤醒、时钟同步后跳变。不钳的话 `now - changedAt` 会变成负数或 NaN，
 * 一路渗进插值系数变成 NaN 姿态（`throw-physics` 那条不变量是同一条教训）。
 */
export function sanitizeTimestamp(raw: number, fallback: number): number {
  const base = Number.isFinite(fallback) ? fallback : 0;
  if (!Number.isFinite(raw)) return base;
  return raw < base ? base : raw;
}

/** 切状态。**状态没变时返回原对象**（引用相等）——宿主据此跳过重渲染/重绘。 */
function withActivity(
  prev: AgentActivityState,
  activity: AgentActivity,
  now: number,
): AgentActivityState {
  if (prev.activity === activity) return prev;
  return {
    ...prev,
    previousActivity: prev.activity,
    activity: activity,
    activityChangedAt: now,
  };
}

/** 一轮结束 / 重置：整轮数据清零，activity 回 idle。 */
function resetTo(prev: AgentActivityState, activity: AgentActivity, now: number): AgentActivityState {
  if (
    prev.activity === activity &&
    prev.turnStartedAt === null &&
    prev.toolCount === 0 &&
    prev.lastToolEndAt === null &&
    prev.blockedAt === null
  ) {
    return prev;
  }
  return {
    activity,
    previousActivity: prev.activity,
    activityChangedAt: now,
    turnStartedAt: null,
    toolCount: 0,
    lastToolEndAt: null,
    blockedAt: null,
    resumeTo: "idle",
  };
}

/**
 * 事件驱动的状态转移。非法/未知事件保持原状态（返回原对象）。
 *
 * 转移表（`→` 左侧为任意状态）：
 * ```
 * 任何      --turn-start-->      thinking（重置本轮计数）
 * 任何      --turn-end-->        idle（整轮清零）
 * 任何      --tool-start-->      working（并清掉迟滞锚点：新工具开始了，段在继续）
 * working   --tool-end-->        working（只记时刻，切不切由 tick 的迟滞决定）
 * working   --waiting-->         waiting（resumeTo = working，响应后接着忙）
 * waiting   --waiting-resolved--> resumeTo
 * 任何      --error-->           blocked
 * ```
 */
export function reduceAgentActivity(
  prev: AgentActivityState,
  event: AgentActivityEvent,
  now: number,
): AgentActivityState {
  const t = sanitizeTimestamp(now, prev.activityChangedAt);

  switch (event.type) {
    case "turn-start":
      // 新的一轮：计数归零。若上一轮没有 turn-end（事件丢失），这里也是兜底复位点。
      return {
        activity: "thinking",
        previousActivity: prev.activity,
        activityChangedAt: t,
        turnStartedAt: t,
        toolCount: 0,
        lastToolEndAt: null,
        blockedAt: null,
        resumeTo: "idle",
      };

    case "turn-end":
      return resetTo(prev, "idle", t);

    case "tool-start": {
      // 工具跑起来了 ⇒ 不管之前在等什么，都已经不 waiting 了。
      // 这是防御性的：`permission:granted` 等事件只发一次，丢了就永远卡在 waiting。
      const base = prev.activity === "waiting" ? withActivity(prev, prev.resumeTo, t) : prev;
      const next = withActivity(base, "working", t);
      // lastToolEndAt 必须清空——否则 tick 会拿「上一个工具结束的时刻」误判本段已结束。
      // 这就是「段」语义的落点：只有最后一个 tool:end 之后的静默才算段结束。
      if (next.lastToolEndAt === null && next.blockedAt === null) return next;
      return { ...next, lastToolEndAt: null, blockedAt: null };
    }

    case "tool-end": {
      // **不改 activity**，只记时刻——段是否结束交给 tick 的迟滞。
      if (prev.activity !== "working") return prev;
      return { ...prev, toolCount: prev.toolCount + 1, lastToolEndAt: t };
    }

    case "waiting": {
      // 已经 waiting 就不覆盖 resumeTo（permission 与 ask-user 可能连发）
      const resumeTo = prev.activity === "waiting" ? prev.resumeTo : prev.activity;
      const next = withActivity(prev, "waiting", t);
      return { ...next, resumeTo: resumeTo === "waiting" ? "thinking" : resumeTo };
    }

    case "waiting-resolved": {
      if (prev.activity !== "waiting") return prev;
      return withActivity(prev, prev.resumeTo, t);
    }

    case "error":
      return { ...prev, activity: "blocked", previousActivity: prev.activity, activityChangedAt: t, blockedAt: t };

    default:
      return prev;
  }
}

/**
 * 时间驱动的收尾转移。宿主在渲染循环里每帧调用（或在 100ms 定时器里调用）。
 *
 * 只管两件事，其余情况**返回原对象**：
 * 1. 工具段迟滞到期 → thinking（轮内）或 idle（轮已结束）
 * 2. blocked 停留到期 → 同上
 */
export function tickAgentActivity(prev: AgentActivityState, now: number): AgentActivityState {
  const t = sanitizeTimestamp(now, prev.activityChangedAt);
  // 轮内回到 thinking（还有活要干），轮外回 idle
  const settled: AgentActivity = prev.turnStartedAt !== null ? "thinking" : "idle";

  if (
    prev.activity === "working" &&
    prev.lastToolEndAt !== null &&
    t - prev.lastToolEndAt >= WORK_SEGMENT_GAP_MS
  ) {
    return withActivity(prev, settled, t);
  }

  if (prev.activity === "blocked" && prev.blockedAt !== null && t - prev.blockedAt >= BLOCKED_HOLD_MS) {
    return withActivity(prev, settled, t);
  }

  return prev;
}

/**
 * 真实事件名 → 语义事件。**未映射的事件返回 null**（调用方据此跳过）。
 *
 * 只映射会改变状态的事件。`agent:message:delta` / `agent:thinking:delta` 这类
 * 高频流式事件**刻意不在表里**：
 * - 它们不改变 activity（正文产出期间 activity 该是什么还是什么；表达层的让位
 *   由调制/编排解决，不是状态机的职责）
 * - `thinking:delta` 每个 token 一个，映射它只会让 reducer 白跑几十万次
 *
 * `agent:abort` 映射成 `error` 是设计文档 §2.3 的原文，但语义存疑：用户**主动**
 * 打断时让宠物「蔫一下」像是责怪用户。且 abort 后紧跟 turn:end，blocked 实际
 * 几乎不可见。保留待实测校准。
 */
const AGENT_EVENT_MAP: Readonly<Record<string, AgentActivityEventType>> = {
  "agent:turn:start": "turn-start",
  "agent:turn:end": "turn-end",
  "agent:idle": "turn-end",
  "agent:tool:start": "tool-start",
  "agent:tool:end": "tool-end",
  "agent:permission:request": "waiting",
  "agent:permission:prompt": "waiting",
  "agent:permission:granted": "waiting-resolved",
  "agent:permission:denied": "waiting-resolved",
  "agent:permission:timeout": "waiting-resolved",
  "agent:permission:prompt:granted": "waiting-resolved",
  "agent:permission:prompt:denied": "waiting-resolved",
  "agent:permission:prompt:timeout": "waiting-resolved",
  "agent:permission:prompt:cancelled": "waiting-resolved",
  "agent:ask-user:request": "waiting",
  "agent:ask-user:cancelled": "waiting-resolved",
  "agent:error": "error",
  "agent:abort": "error",
};

export function mapAgentEvent(type: string): AgentActivityEvent | null {
  const mapped = AGENT_EVENT_MAP[type];
  return mapped ? { type: mapped } : null;
}
