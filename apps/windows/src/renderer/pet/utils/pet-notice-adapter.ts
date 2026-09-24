/**
 * pet-notice-adapter —— 镜像的 Agent 事件 → pet-core 的 `NoticeEvent`
 *
 * 设计：docs/design/客户端UI/2026-09-22-Agent通知与审批闭环设计.md §八
 * 实施：docs/plans/客户端UI/2026-09-23-Agent通知与审批闭环实施计划.md
 *
 * ## 为什么要有这一层
 *
 * pet-core 不认识协议字符串，也不该认识（`notice.ts` 的映射表拿的是**结构化字段**）。
 * 这一层负责三件只有宿主做得了的事：
 *
 * 1. **会话键归一**：`rootSessionKey ?? sessionKey`——子 Agent 各有一把 key 但共用一个 root，
 *    按 root 归并才不会把一次委派拆成"好几个会话在等你"（与 `session-activity.ts` 同一口径）。
 * 2. **`task_complete` 的摘要解析**：它在 `result.content[].text` 的 JSON 里。同一段解析
 *    主窗也有一份（`useAgentRuntime/event-handler.ts`），这里是宠物窗口那一份。
 * 3. **两个"事实"**：本轮是否调过 `task_complete`、本轮是否由用户发起——事件里没有这两项，
 *    得宿主自己数（见 {@link NoticeTurnFacts}）。
 *
 * ## 为什么要有 {@link isNoticeEvent} 这道闸
 *
 * `agent:message:delta` / `thinking:delta` 是**逐 token** 的，每秒几百条。虽然
 * `reduceNotices` 对它们会原样返回（引用不变），但白跑几百次对象构造不划算。
 */

import { TASK_COMPLETE_TOOL_NAME, type NoticeEvent, type PetNotice } from '@mtbot/pet-core'

/**
 * 待办条目 / 气泡按钮上的文案：按**处置入口**给。
 *
 * 不给"确定/取消"这类没有信息量的词——用户要一眼看出点下去会发生什么（切到会话 ≠ 批准）。
 *
 * 感知类（`pet-sensing`）单独给一句：它**没有可处置的东西**（设计 §4.1.5 第 3 条：
 * 感知类只走气泡），但那条条目带的是"你刚才在用的会话"，所以点下去的动作是
 * "回到刚才"而不是默认的"去看看"——后者对着「要不要歇会儿」读起来像在问"去看什么"。
 */
export function noticeActionLabel(notice: PetNotice): string {
  if (notice.kind === 'pet-sensing') return '回到刚才'
  switch (notice.deepLink?.to) {
    case 'permission':
      return '去审批'
    case 'ask-user':
      return '去回答'
    default:
      return '去看看'
  }
}

/**
 * 一条镜像事件里我们关心的字段。
 *
 * 全部可选：这是 IPC 那头送来的 `unknown`，本层负责把它**安全地**读成结构化字段
 * （缺字段就是 `undefined`，由 pet-core 决定"缺了还能不能产生通知"）。
 */
export interface RawAgentEvent {
  readonly type?: string
  readonly sessionKey?: string
  readonly rootSessionKey?: string
  readonly requestId?: string
  readonly toolName?: string
  readonly description?: string
  /** `agent:tool:end` 的工具结果（`task_complete` 的摘要在这里面） */
  readonly result?: unknown
  readonly durationMs?: number
  readonly turnIndex?: number
  readonly messageId?: string
  readonly timeoutMs?: number
  /** `agent:subagent:completed` 的子 Agent 名与状态 */
  readonly name?: string
  readonly status?: string
  readonly errorCode?: string
  readonly isError?: boolean
  readonly isRetryable?: boolean
  readonly reason?: string
  readonly fileChanges?: readonly unknown[]
  /** `agent:permission:request` 已被自动审批放行（消费方据此不叫人，见事件类型的注释） */
  readonly autoApproved?: boolean
  /**
   * `pet:goal:result`（三期 T3.5）与 `pet:sensing`（四期）共用的两个字段：
   * 宠物说的话 + 成没成（只有目标回执有 `ok`）。
   *
   * 这两条**不是** Agent 事件——它们是宠物自己那条管道的产物（主进程 `pet-dispatch` /
   * `pet-sensing-tick` 推的）。走同一张表是因为"气泡 + 控制坞一行 + 30 秒自清"
   * 正是 `report` 档的语义，另起一套只会多出一份限流与免打扰判定。
   *
   * ⚠ 字段名必须与 `shared/agent-runtime-events.ts` 的 `PetGoalResultEvent` /
   * `PetSensingEvent` **逐字一致**。名字对不上不会报错：`text` 读成 `undefined`
   * → pet-core 用兜底文案或干脆不产生，表现是气泡冒出来了、说的却是别的话——
   * **2026-09-24 真机第一跑就是这么错的**（适配器写 `petText`、线上发 `text`）。
   * 现在由 `pet-notice-adapter.test.ts` 里那两条**按线上类型构造**的用例钉住：
   * 两边漂移时 **tsc 会红**，不是等到用户看见一句含糊话。
   *
   * 事件上还带着 `petAgentId`（回执）与 `kind`（感知），这里**刻意不读**：
   * 气泡归属靠 `sessionKey`，而 `kind` 目前没有消费者。要用时再加，别提前搬进来。
   */
  readonly text?: string
  readonly ok?: boolean
}

/**
 * 本轮的"事实"。**由调用方跨事件记账**，`turn:start` 时复位。
 *
 * ⚠️ `userInitiated` 目前**拿不到**（镜像事件里没有来源标记，宠物窗口也不知道主窗是谁在打字），
 * 所以先恒为 `false`。影响两条规则，都是"少打扰"的方向，不会产生错误打扰：
 * - `turn:end` 的「用户发起后主窗失焦 → 补一句」不触发（仍有"跑满 90s"那条主判据）
 * - `turn:file-changes` 的「用户没参与」判据退回只看"主窗失焦"
 *
 * 要补的话，判据是**本轮有没有 user 角色的消息**（`agent:message:start` 带 role），
 * 在同一个记账点顺手置位即可。
 */
export interface NoticeTurnFacts {
  /** 本轮是否调用过 `task_complete`（用它让 `turn:end` 的那句"跑完了"让位） */
  readonly sawTaskComplete: boolean
  /** 本轮是否由用户发起（见上方 ⚠️） */
  readonly userInitiated: boolean
}

export const INITIAL_TURN_FACTS: NoticeTurnFacts = { sawTaskComplete: false, userInitiated: false }

/**
 * 这些事件会影响通知列表——**其余一律不折**。
 *
 * 与 `notice.ts` 的两张表一一对应（产生类 + 销账类）。pet-core 不认识协议字符串，
 * 所以这张清单只能由宿主维护；**改 `notice.ts` 的映射表时，这里要跟着改**。
 */
const NOTICE_EVENT_TYPES: ReadonlySet<string> = new Set([
  // 产生
  'agent:tool:end',
  'agent:turn:end',
  'agent:permission:request',
  'agent:permission:prompt',
  'agent:ask-user:request',
  'agent:subagent:completed',
  'agent:error',
  'agent:abort',
  'agent:turn:file-changes',
  // 宠物自己的目标回执（三期 T3.5）：走 report 档，与上面几张表同一套限流与免打扰
  'pet:goal:result',
  // 宠物感知到的一句话（四期 T4.2/T4.3）：同上，走 report 档
  'pet:sensing',
  // 销账
  'agent:permission:granted',
  'agent:permission:denied',
  'agent:permission:timeout',
  'agent:permission:prompt:granted',
  'agent:permission:prompt:denied',
  'agent:permission:prompt:timeout',
  'agent:permission:prompt:cancelled',
  'agent:ask-user:cancelled',
])

/** 这条事件会不会影响通知列表？（热路径上先挡一道，别看它逐 token 地跑） */
export function isNoticeEvent(type: string): boolean {
  return NOTICE_EVENT_TYPES.has(type)
}

/**
 * `autonomous:mood:emotion` 是不是**这只宠物自己的**（四期 T4.4）。
 *
 * 这条 IPC 以前不带归属，而唯一的生产者是 `assistant` 那条线（`recordMoodEvent` 的默认
 * agentId），于是宠物窗把**助手的心情**当成了自己的脸。宠物是独立 Agent（设计 §3.7），
 * 所以渲染层必须按 `agentId` 认领。
 *
 * ⚠ **认不出主人时返回 false**（`petAgentId` 还没拿到、事件没带 agentId）：宁可这一拍不采纳，
 * 也不要猜——猜错的形态是**宠物为助手的情绪雀跃或沮丧**，不报错、日志里也看不出，
 * 只能靠用户觉得别扭。
 *
 * 单独抽出来是因为它是**纯判断**：留在组件的 effect 里就只能靠真机复验，
 * 而这里能用几条用例把四种组合钉死。
 */
export function isPetMoodEvent(event: { agentId?: string }, petAgentId: string | null): boolean {
  return petAgentId !== null && event.agentId === petAgentId
}

/**
 * `task_complete` 的结果：`result.content[].text` 是一段 JSON。
 *
 * ⚠️ **不是每次 `tool:end` 都代表完成**。这个工具有一道"验证门"：第一次调用若没检测到
 * 验证步骤（没跑 test/build/lint），它会返回一段**提示**让你再调一次——而那次 `isError`
 * 是 **false**。只看"工具名 + 没报错"就会把它当成完成：一轮任务冒**两次**「做完了」，
 * 第一次那句还是**假的**，而且它会把"每会话 1 条/分钟"的配额吃掉，让**真完成那次**
 * 反而冒不出来。
 *
 * 判据只有一条：`status === 'completed'`。
 * （这是 2026-09-23 跑 `check-notice-e2e.mjs` 的真实用户旅程时抓到的。）
 */
export function extractTaskCompletion(result: unknown): { completed: boolean; summary?: string } {
  try {
    const content = (result as { content?: readonly { type?: string; text?: string }[] } | null)?.content
    const text = content?.find((c) => c?.type === 'text')?.text
    if (!text) return { completed: false }
    const parsed = JSON.parse(text) as { status?: unknown; summary?: unknown }
    if (parsed?.status !== 'completed') return { completed: false }
    const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : ''
    return { completed: true, summary: summary || undefined }
  } catch {
    return { completed: false }
  }
}

/**
 * 镜像事件 → `NoticeEvent`。**调用方先用 {@link isNoticeEvent} 挡一道**（本函数不挡，
 * 它对任何输入都返回结构，只是不相关的事件在 pet-core 那边会被原样忽略）。
 *
 * 返回 `null` 只有一种情况：**没有会话键**——那种事件连"归到哪个会话"都答不上来，
 * 折进去只会造出一条点了不知道去哪的待办。
 */
export function toNoticeEvent(raw: RawAgentEvent, facts: NoticeTurnFacts): NoticeEvent | null {
  const type = raw.type
  if (!type) return null
  const sessionKey = raw.rootSessionKey ?? raw.sessionKey
  if (!sessionKey || !sessionKey.trim()) return null

  /**
   * `task_complete` 只认**真的完成**（见 `extractTaskCompletion` 的长注释）：
   * 验证门那次也是 `isError=false`，但它是"再调一次"的提示。
   * 那一条**整条丢掉**（返回 null），而不是"传个空摘要让 pet-core 用兜底文案"——
   * 冒一句"任务做完了"而其实没做完，比不冒更糟。
   */
  let summary: string | undefined
  if (raw.toolName === TASK_COMPLETE_TOOL_NAME) {
    const done = extractTaskCompletion(raw.result)
    if (!done.completed) return null
    summary = done.summary
  } else if (type === 'pet:goal:result' || type === 'pet:sensing') {
    // 宠物报的原话**就是**气泡文案：pet-core 不改写它（回执失败时只加一句前缀）。
    // 空串按"没话说"处理：目标回执交给 pet-core 用兜底文案（用户交代的事，
    // 回执宁可含糊也不能吞），感知类那边会直接不产生（说了没听见就算了）——
    // 这条差别在 `notice.ts` 的两个 case 里。
    summary = raw.text?.trim() || undefined
  }

  return {
    type,
    sessionKey,
    requestId: raw.requestId,
    toolName: raw.toolName,
    description: raw.description,
    summary,
    durationMs: raw.durationMs,
    turnIndex: raw.turnIndex,
    messageId: raw.messageId,
    timeoutMs: raw.timeoutMs,
    autoApproved: raw.autoApproved,
    subagentName: raw.name,
    subagentStatus: raw.status,
    errorCode: raw.errorCode,
    isError: raw.isError,
    isRetryable: raw.isRetryable,
    reason: raw.reason,
    fileCount: raw.fileChanges?.length,
    hasTaskComplete: facts.sawTaskComplete,
    userInitiated: facts.userInitiated,
    ...(type === 'pet:goal:result' ? { ok: raw.ok !== false } : {}),
  }
}

/**
 * 把一条事件折进"本轮事实"。**必须在 `toNoticeEvent` 之前调**——
 * `task_complete` 的 `tool:end` 与 `turn:end` 是两个事件，前者要先把标志立起来，
 * 后者才让得了位。
 *
 * 同样只认**真的完成**（验证门那次不立标志）：否则"验证门之后 Agent 被中断"的场景里，
 * `turn:end` 会因为 `sawTaskComplete` 而让位——那一轮既没完成通知、又没了"跑完了"那句。
 *
 * 返回值：`turn:start` 时复位后的新事实（调用方存回 ref）；其余事件原样返回。
 */
export function advanceTurnFacts(facts: NoticeTurnFacts, raw: RawAgentEvent): NoticeTurnFacts {
  if (raw.type === 'agent:turn:start') return INITIAL_TURN_FACTS
  if (raw.type === 'agent:tool:end' && raw.toolName === TASK_COMPLETE_TOOL_NAME) {
    if (!extractTaskCompletion(raw.result).completed) return facts
    return { ...facts, sawTaskComplete: true }
  }
  return facts
}
