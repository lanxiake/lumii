/**
 * agent-activity-announce —— 气泡短句的挑选规则（pet-core，纯函数）
 *
 * 表达分四层，本模块是 **L4「气泡短句」**：感知最强、也最容易变成骚扰的一层。
 * 参考项目每 10~20 秒随机冒一句台词——那是骚扰，且违反「不表演」（每个可见行为
 * 都必须能追溯到一条真实事件）。这里的规则是反过来的：**宁可不说，不要废话**。
 *
 * 设计：docs/design/客户端UI/2026-09-21-Agent状态可见化设计.md §3.2
 *
 * ## ⚠️ 为什么气泡要有自己的生命周期
 *
 * 实测（2026-09-21 日志）：`waiting` 常常**只存在 0 毫秒**——
 * `thinking → waiting (event=waiting)` 与 `thinking → working (event=tool-start)`
 * 打在同一毫秒。如果气泡跟着 activity 生死，「需要你确认一下」这一句**永远冒不出来**，
 * 而它恰恰是四层里唯一值得强打扰的那个。
 *
 * 所以本模块只回答「**此刻该不该冒、冒哪一句**」；冒出来之后停多久、什么时候撤，
 * 由 UI 层按自己的时钟决定（见 PetOrchestrator 的 `announceTtlMs`）。
 *
 * ## 三条克制规则
 *
 * 1. **默认不冒**：thinking / working 全程安静，只有"忙得太久"才冒一次
 * 2. **同一轮只冒一次**：一条工作段里连冒三次「还在忙…」等于没说
 * 3. **同一句话 10 分钟内不重复**：跨轮次也压住
 */

import type { AgentActivityState } from "./agent-activity.js";

/** 一条待冒的气泡 */
export interface AgentAnnouncement {
  /** 节流身份。同一 key 在 `ANNOUNCE_THROTTLE_MS` 内不重复冒 */
  readonly key: string;
  readonly text: string;
}

/**
 * 同一句话的最小间隔。
 *
 * 10 分钟是按"用户被打断一次要多久才不烦"取的，不是按数据——待实测校准。
 */
export const ANNOUNCE_THROTTLE_MS = 10 * 60 * 1000;

/**
 * 「还在忙…」的两条触发条件，满足**任一**即可（都只在 working 下判）。
 *
 * 为什么是"或"而不是"且"：长任务里工具数往往不多（一个长命令跑 3 分钟），
 * 而碎任务里工具数涨得快却总时长很短。两种"忙"都该被看见。
 */
export const WORK_LONG_MS = 60_000;
export const WORK_MANY_TOOLS = 15;

/** 气泡文本。硬编码在这里，将来接创作平台时整表替掉即可。 */
export const ANNOUNCE_TEXTS = {
  workingLong: "还在忙…",
  waiting: "需要你确认一下",
  blocked: "出错了",
} as const;

export const ANNOUNCE_KEYS = {
  workingLong: "working-long",
  waiting: "waiting",
  blocked: "blocked",
} as const;

/**
 * 挑一条此刻该冒的气泡；没有就返回 null。
 *
 * @param state     当前 Agent 活动状态
 * @param now       当前时刻（与 `reduceAgentActivity` 用同一个时钟）
 * @param lastShown key → 上次冒出的时刻。调用方维护，本函数只读
 * @param shownThisTurn 本轮已经冒过的 key。调用方在 `turn-start` 时清空
 *
 * 三条规则全部在这里收口，UI 层不必再判。
 */
export function pickAgentAnnouncement(
  state: AgentActivityState,
  now: number,
  lastShown: ReadonlyMap<string, number> = new Map(),
  shownThisTurn: ReadonlySet<string> = new Set(),
): AgentAnnouncement | null {
  const pick = (key: string, text: string, oncePerTurn: boolean): AgentAnnouncement | null => {
    if (oncePerTurn && shownThisTurn.has(key)) return null;
    const last = lastShown.get(key);
    if (last !== undefined && now - last < ANNOUNCE_THROTTLE_MS) return null;
    return { key, text };
  };

  switch (state.activity) {
    // 唯一默认开启的强打扰。**永远不 oncePerTurn**：用户可能在一次长任务里被问两次，
    // 第二次同样值得叫他回来，而 10 分钟的节流已经挡住了"连着弹"。
    case "waiting":
      return pick(ANNOUNCE_KEYS.waiting, ANNOUNCE_TEXTS.waiting, false);

    case "blocked":
      // 出错冒一次就够。blocked 本身只停 BLOCKED_HOLD_MS（3s），
      // 跟着它冒会变成三秒一次的复读机。
      return pick(ANNOUNCE_KEYS.blocked, ANNOUNCE_TEXTS.blocked, true);

    case "working": {
      const workedLongEnough =
        state.turnStartedAt !== null && now - state.turnStartedAt >= WORK_LONG_MS;
      const manyTools = state.toolCount > WORK_MANY_TOOLS;
      if (!workedLongEnough && !manyTools) return null;
      return pick(ANNOUNCE_KEYS.workingLong, ANNOUNCE_TEXTS.workingLong, true);
    }

    // idle 与 thinking 都不冒：前者没状态可说，后者是"还没开始忙"。
    default:
      return null;
  }
}

/**
 * 气泡该停多久。
 *
 * 按**文本长度**给，不是固定值：四字短语停 3 秒够，长句得给够读完的时间。
 * 中文按 ~4 字/秒的阅读速度 + 1 秒的注意起跳。
 */
export function announceDurationMs(text: string): number {
  const chars = [...text].length;
  return Math.min(6000, Math.max(2600, 1000 + Math.round((chars / 4) * 1000)));
}
