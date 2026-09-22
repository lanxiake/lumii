/**
 * session-activity — 多个会话同时在跑时，"宠物该演谁、别人怎么办"的状态机
 *
 * 由来：用户 2026-09-22 问「将 AGENT 执行状态接入到宠物中，但同时可以运行多个 AGENT
 * 和会话，这些该怎么处理呢」。定下来的三条（用户挑的）：
 *
 *   1. **默认演当前会话**——你打开哪个会话，宠物就演哪个。
 *   2. **"需要你出手"的事件跨会话抢占**——`permission`/`ask-user` 这类不管在哪个会话
 *      都在等你，而宠物是屏幕上最合适的提示位。
 *   3. **其余在跑的会话只做"可见"，不做"演绎"**——控制坞里计数/列清单，
 *      **不参与姿态与表情**。后台 cron agent 常年有活，让它参与的话宠物会永远在抖。
 *
 * ## 数据从哪来（不需要新 IPC）
 *
 * 宠物窗口**本来就收所有会话的事件**（它此前是按会话过滤后丢掉别人的），
 * 所以这里只是把那些被丢掉的事件**顺手折进一张表**。不新增任何主进程接口。
 *
 * ## 身份按 rootSessionKey 归一
 *
 * 与 `petSessionMatchesEvent` 同一口径：子 Agent 的 `sessionKey` 各不相同但共用一个
 * `rootSessionKey`，按 root 归并才不会把一次委派拆成"好几个会话在跑"。
 *
 * 纯函数、零依赖：可脱开 React 单测。
 */

/**
 * 一个会话的**运行态**（不是对话内容，也不是 Agent 的情绪）。
 *
 * 只留这三种：`running`（在干活）、`waiting`（等你出手）、`error`（断了）。
 * 不细分 thinking/working——那是**主体会话**才需要的精度（头顶符号用它区分），
 * 而这里问的是"别人还要不要我管"。
 */
export type SessionRunState = 'running' | 'waiting' | 'error'

export interface SessionRun {
  /** 归一后的键（rootSessionKey 优先） */
  sessionKey: string
  state: SessionRunState
  /** 最近一次事件的时刻（由调用方传入，通常是 performance.now()） */
  updatedAt: number
}

export interface SessionActivityState {
  /** 归一键 → 运行态 */
  readonly runs: Readonly<Record<string, SessionRun>>
}

export const EMPTY_SESSION_ACTIVITY: SessionActivityState = { runs: {} }

/**
 * 事件类型 → 状态迁移。
 *
 * 与 pet-core 的 `AGENT_EVENT_MAP` 是**两套语义**，刻意不共用：
 * 那边回答"Agent 此刻是什么姿态"（thinking/working/waiting/blocked，驱动呼吸），
 * 这边回答"这个会话还要不要我管"（要不要留在表里）。硬合成一张表，
 * 两边任一改口径都会悄悄影响另一边。
 */
const WAITING_EVENTS = new Set([
  'agent:permission:request',
  'agent:permission:prompt',
  'agent:ask-user:request',
])
const WAITING_RESOLVED_EVENTS = new Set([
  'agent:permission:granted',
  'agent:permission:denied',
  'agent:permission:timeout',
  'agent:permission:prompt:granted',
  'agent:permission:prompt:denied',
  'agent:permission:prompt:timeout',
  'agent:permission:prompt:cancelled',
  'agent:ask-user:cancelled',
])
const ERROR_EVENTS = new Set(['agent:error', 'agent:abort'])
/** 会话结束：从表里摘掉（不是"变成 idle 留在表里"） */
const END_EVENTS = new Set(['agent:turn:end', 'agent:idle'])
/** 只是"还在动"的心跳：状态不变，只刷新时间戳 */
const HEARTBEAT_EVENTS = new Set([
  'agent:tool:start',
  'agent:tool:end',
  'agent:message:start',
])

/**
 * 这条事件会不会改变运行态？
 *
 * 给调用方在**热路径上先挡一道**用的：`agent:message:delta` 是逐 token 的，
 * 每秒几百条，虽然 `reduceSessionActivity` 对它们会原样返回（引用不变，
 * React 会跳过重渲染），但白跑几百次函数调用不如一次 Set 命中。
 */
export function isSessionActivityEvent(type: string): boolean {
  return (
    type === 'agent:turn:start' ||
    END_EVENTS.has(type) ||
    HEARTBEAT_EVENTS.has(type) ||
    WAITING_EVENTS.has(type) ||
    WAITING_RESOLVED_EVENTS.has(type) ||
    ERROR_EVENTS.has(type)
  )
}

/** 会话键归一：子 Agent 各有一把 key，但共用一个 root */
export function normalizeSessionKey(event: {
  sessionKey?: string
  rootSessionKey?: string
}): string | null {
  const key = event.rootSessionKey ?? event.sessionKey
  return key && key.trim() ? key : null
}

/**
 * 把一条事件折进状态。**不认识的事件原样返回**（引用不变，React 那边可以据此跳过重渲染）。
 */
export function reduceSessionActivity(
  state: SessionActivityState,
  event: { type?: string; sessionKey?: string; rootSessionKey?: string },
  now: number,
): SessionActivityState {
  const type = event.type ?? ''
  const key = normalizeSessionKey(event)
  if (!key) return state

  if (END_EVENTS.has(type)) {
    if (!state.runs[key]) return state
    const runs = { ...state.runs }
    delete runs[key]
    return { runs }
  }

  let nextState: SessionRunState | null = null
  if (type === 'agent:turn:start') nextState = 'running'
  else if (WAITING_EVENTS.has(type)) nextState = 'waiting'
  else if (ERROR_EVENTS.has(type)) nextState = 'error'
  else if (WAITING_RESOLVED_EVENTS.has(type)) nextState = 'running'

  const known = state.runs[key]
  if (nextState === null && !HEARTBEAT_EVENTS.has(type)) return state
  if (nextState === null && !known) return state // 心跳但没见过开场：不凭空造条目

  const resolved = nextState ?? known!.state
  if (known && known.state === resolved && known.updatedAt === now) return state
  return { runs: { ...state.runs, [key]: { sessionKey: key, state: resolved, updatedAt: now } } }
}

/** 除主体之外还在跑的会话，按最近活跃倒序（主体自己在里面也不算"别人"） */
export function otherSessions(
  state: SessionActivityState,
  subjectKey: string | null,
): SessionRun[] {
  return Object.values(state.runs)
    .filter((r) => r.sessionKey !== subjectKey)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 需要用户出手的会话（在等确认 / 断了），**主体自己不算**——
 * 主体的情况头顶符号本来就会说，这里专门回答"别人有没有在等你"。
 */
export function foreignAttention(
  state: SessionActivityState,
  subjectKey: string | null,
): SessionRun[] {
  return otherSessions(state, subjectKey).filter((r) => r.state !== 'running')
}

/**
 * 清掉长时间没有心跳的条目。
 *
 * 为什么需要：`turn:end` 是**事件**，丢了就永远留在表里（窗口重载、事件在
 * 渲染进程忙的时候被合并……都会丢）。留着不动的条目会让控制坞一直说
 * "另有 1 个会话在跑"，而那个会话其实早就结束了。
 *
 * 阈值取得比一次长任务宽：宁可多留一会儿，也不能把正在跑的会话误删。
 */
export const STALE_AFTER_MS = 10 * 60 * 1000

export function sweepStale(state: SessionActivityState, now: number): SessionActivityState {
  const kept = Object.values(state.runs).filter((r) => now - r.updatedAt < STALE_AFTER_MS)
  if (kept.length === Object.keys(state.runs).length) return state
  return { runs: Object.fromEntries(kept.map((r) => [r.sessionKey, r])) }
}

/**
 * 会话键 → 给人看的短名。
 *
 * **只是给眼睛看的**，不参与任何判据（判据一律用完整 key）。事件的信封里没有会话标题，
 * 拉标题要走另一套接口，而这里的用途是"控制坞里那行小字"——不值得为它再引一条链路。
 * 所以策略是"把 id 段丢掉、留下有语义的段"：
 * `cron:agent-self:1790026929462-owrcvos` → `cron:agent-self`。
 */
export function shortSessionLabel(key: string): string {
  const parts = key.split(':').filter(Boolean)
  // id 段的两种长相都见过：纯 hex（uuid 截断）与「毫秒时间戳-随机串」
  const isIdLike = (p: string): boolean => /^[0-9a-f]{8,}$/i.test(p) || /^\d{5,}[-a-z0-9]*$/i.test(p)
  const meaningful = parts.filter((p) => !isIdLike(p))
  if (meaningful.length > 0) return meaningful.join(':')
  return parts[parts.length - 1] ?? key
}
