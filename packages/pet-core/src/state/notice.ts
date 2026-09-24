/**
 * notice —— 第二个维度：「要不要我现在看一眼」（pet-core，纯函数）
 *
 * 设计：docs/design/客户端UI/2026-09-22-Agent通知与审批闭环设计.md
 *
 * ## 与 agentActivity 的分工（别把两者合并）
 *
 * `agentActivity`（`./agent-activity.ts`）回答「**Agent 现在在忙什么**」，是一条**连续的底色**——
 * 用户可以不看它，错过也没有代价。本模块回答的是另一类问题：「**要不要我现在看一眼**」，
 * 是有生命周期的事件：产生 → 处置 / 过期。
 *
 * |  | agentActivity | PetNotice（本模块） |
 * | --- | --- | --- |
 * | 时间性 | 当前态，下一秒就被 `tool:start` 覆盖 | 有生命周期，处置或过期才走 |
 * | 数量 | 每会话恒为 1 | 一会话可多条，全局要排队 |
 * | 错过的代价 | 无 | **有**——`action` 档的审批 5 分钟超时即 deny，任务带着"被拒绝"往下跑 |
 *
 * 把它们塞进同一维度会同时坏掉两边：`task_complete` 塞进 `waiting` 的话，用户看到"需要你确认"
 * 而其实已经干完了；而 `action` 会被下一个 `tool:start` 顶掉——**那条待办凭空消失，其实它刚被 deny**。
 *
 * ## 三档紧迫度
 *
 * - `ambient`：知道就好。**不进任何通道**（产生了只是记账，为将来的开关留位）。
 * - `report`：干完了，来看一眼。气泡 + 控制坞一行，**30s 后自清**。
 * - `action`：卡住了，非你不可。气泡 + 头顶符号 + 控制坞 + 系统通知，**等处置或超时**。
 *
 * ## 三个容易写错的地方
 *
 * 1. **销账 ≠ 删除**。`resolvedAt`/`resolution` 保留在条目上——控制坞要能显示「已超时被拒」，
 *    而且"同一个 id 只叫一次"的幂等正是靠"条目还在列表里"实现的（见 {@link reduceNotices}）。
 * 2. **超时要有本地兜底**。`agent:permission:timeout` 事件存在，但事件可能丢；条目自带
 *    `timeoutAt`，由 {@link tickNotices} 在到点时标为已超时。§7.1 的教训：审批的解除事件族
 *    曾经"全仓零产出"，只有事件、没有发送者。
 * 3. **`agent:turn:end` 本身不入表**。实测当日 205 个 turn——每个结束都通知一次就是 205 次骚扰。
 *    只有"跑得够久"或"用户发起后走开了"才升级为 `report`。
 *
 * ## 本模块不认识的东西
 *
 * 会话键的归一（`rootSessionKey ?? sessionKey`）、`summary` 的解析（在 `result.content` 里）、
 * 「本轮有没有调过 task_complete」——**都是宿主的事**，由调用方填进 {@link NoticeEvent}。
 * pet-core 保持零依赖，也不重复实现 app 层已有的规则（`renderer/pet/utils/session-activity.ts`）。
 */

import { sanitizeTimestamp } from "./agent-activity.js";
import { ANNOUNCE_THROTTLE_MS } from "./agent-activity-announce.js";
import { isPetSessionKey } from "../personality/pet-identity.js";

/** 紧迫度三档。语义见文件头。 */
export type NoticeLevel = "ambient" | "report" | "action";

/**
 * 通知种类。
 *
 * 刻意**不含**「自主进化目标审批」——那套走 `outreach-budget` 的预算、不与本表共用计数器
 * （设计 §四 表末行），属另一条线。
 *
 * `pet-goal`（2026-09-24 三期 T3.5）是**宠物自己**跑完用户交代的一件事：它没有对应的
 * Agent 会话回合，所以不能借用 `task-complete`——那个种类的语义是"某个会话的一轮干完了"，
 * 报出去会让用户去找一个并不存在的会话。
 *
 * `pet-sensing`（2026-09-24 四期 T4.2/T4.3）是宠物**看着你**说出的一句话
 *（「要不要歇会儿」「你在弄『X』，两个多小时了」）。它既不是别人的会话也不是自己的活，
 * 所以同样不能借用现成的种类。
 */
export type NoticeKind =
  | "task-complete"
  | "long-turn"
  | "permission"
  | "ask-user"
  | "subagent-failed"
  | "turn-error"
  | "file-changes"
  | "pet-goal"
  | "pet-sensing";

/** 处置入口。`action` 档必填——没有它的通知是"看得见、点不动"的假通知。 */
export type NoticeDeepLink =
  | { readonly to: "session" }
  | { readonly to: "permission"; readonly requestId: string }
  | { readonly to: "ask-user"; readonly requestId: string };

/** 销账原因。**只由事件决定，不因 UI 状态变化**（设计 §十.1）。 */
export type NoticeOutcome = "granted" | "denied" | "timeout" | "cancelled" | "answered";

export interface PetNotice {
  /** 幂等键（见各映射行）。同 id 在列表里出现过就不再生第二条。 */
  readonly id: string;
  readonly kind: NoticeKind;
  readonly level: NoticeLevel;
  /** 归一化后的会话键（`rootSessionKey ?? sessionKey`，由调用方保证） */
  readonly sessionKey: string;
  readonly createdAt: number;
  /** 气泡文案 */
  readonly text: string;
  /**
   * 这条的**情绪色调**。缺省（`undefined`）= 中性，按"好消息"处理。
   *
   * 只有一个消费者：气泡冒出来时的庆祝粒子。`report` 档"完成时放一次粒子"是设计 §5.1
   * 的通道表，但**做砸了的回执也走 `report` 档**（它同样"不需要用户出手"，见
   * `pet:goal:result` 的注释）——不给个体标记的话，宠物把事情办砸了却在眼前放烟花。
   *
   * ⚠ 刻意**不复用 `level`**：`action` 的语义是"非你不可"，失败回执不需要用户出手，
   * 抬到 `action` 会额外触发系统通知、且永远挂着不退（`action` 不设 TTL）。
   * 档位管"要不要占用你的注意力"，色调管"这是好事还是坏事"，两件事。
   */
  readonly tone?: "positive" | "negative";
  /**
   * 这句话可以**派它去做**的一件具体事（五期 T5.1②）。
   *
   * 只有感知类（`pet-sensing`）会带它。有它时那个按钮的含义变了：
   * 不是"回到那个会话"，而是"让我去看看"——点一下真的派出一个宠物目标
   * （见宿主侧的 `noticeActionLabel` 与 `handleFocusNotice`）。
   *
   * 缺省（`undefined`）= 没有可派的事，按钮维持原来的语义。
   */
  readonly proposal?: { readonly description: string };
  /** `action` 档必填：处置它的深链 */
  readonly deepLink?: NoticeDeepLink;
  /** `report`/`ambient` 的展示时长：到点自清（`action` 没有这个——它要一直挂着） */
  readonly ttlMs?: number;
  /** `action` 档的本地超时兜底：到点标为 `timeout`（事件丢失时的保险） */
  readonly timeoutAt?: number;
  /** 已销账：时刻 + 原因。销账 ≠ 删除，见文件头。 */
  readonly resolvedAt?: number;
  readonly resolution?: NoticeOutcome;
}

/**
 * 一条 Agent 事件。字段全部可选——**缺字段时返回 null 而不是造一条残缺通知**
 * （设计 §十.1 的不变量）：缺 `sessionKey` 就没法归会话，缺 `requestId` 就没法去审批。
 *
 * 字段名尽量贴着真实事件（`apps/windows/src/shared/agent-runtime-events.ts`），
 * 但有三个是**宿主判断后填进来的事实**，事件里没有：
 * `hasTaskComplete` / `userInitiated` / `fileCount`。
 */
export interface NoticeEvent {
  readonly type: string;
  /** 归一化后的会话键。**所有映射都要求它非空。** */
  readonly sessionKey?: string;
  readonly requestId?: string;
  readonly toolName?: string;
  /** 审批卡上的那行说明（`agent:permission:request.description`） */
  readonly description?: string;
  /** `task_complete` 的结果摘要（宿主从 `result.content[].text` 的 JSON 里取 `summary`） */
  readonly summary?: string;
  /** `agent:turn:end` 的 `durationMs` */
  readonly durationMs?: number;
  readonly turnIndex?: number;
  /** `agent:turn:file-changes` 的 `messageId`（`turnIndex` 缺失时的幂等兜底） */
  readonly messageId?: string;
  /** 宿主记账：本轮是否调用过 `task_complete`（避免与完成通知重复） */
  readonly hasTaskComplete?: boolean;
  /** 宿主记账：本轮是否由用户发起 */
  readonly userInitiated?: boolean;
  /** 权限请求的审批超时（`agent:permission:request.timeoutMs`） */
  readonly timeoutMs?: number;
  /**
   * 这条权限请求是否**已经被自动审批放行**（`agent:permission:request.autoApproved`）。
   *
   * 自动放行时**不叫用户**：那条请求 3 毫秒后就被放行了（实测），通知刚产生就销账——
   * 气泡压根没机会冒出来，**而系统通知已经弹出去收不回**。
   */
  readonly autoApproved?: boolean;
  /** `agent:subagent:completed` 的 `name` / `status` */
  readonly subagentName?: string;
  readonly subagentStatus?: string;
  /** `agent:error` */
  readonly errorCode?: string;
  readonly isError?: boolean;
  readonly isRetryable?: boolean;
  /** `agent:abort` */
  readonly reason?: string;
  /** `agent:turn:file-changes`：改动文件数（宿主从 `fileChanges.length` 取） */
  readonly fileCount?: number;
  /**
   * 宠物目标成没成（`pet:goal:result.ok`）。**只有宠物那条事件会带它。**
   *
   * 缺省（`undefined`）按"成"处理——旧事件没有这个字段，而"没成"必须由发送方**明确说**，
   * 不能靠字段缺失来推断：把成功说成失败，比把失败说成成功危害小，但两者都是撒谎。
   */
  readonly ok?: boolean;
  /**
   * 这条回执是哪**一个**目标产生的（`pet:goal:result.goalId`）。
   *
   * 判据只能是它，不能是文案——见 `pet:goal:result` 的幂等键注释：失败文案是个常量，
   * 哈希文案会让"第二次失败"被当成重放而永远冒不出来。
   */
  readonly goalId?: string;
  /**
   * 这条话可以派它去做的一件具体事（`pet:sensing.proposal`，五期 T5.1②）。
   *
   * 缺省 = 没建议。**不是所有感知类都有**：说得出一件具体的事才给这个出口
   * （理由见宿主侧 `pet-sensing.ts` 的 `proposalFor`）。
   */
  readonly proposal?: { readonly description: string };
}

/** 产生通知时的环境。`now` 与 `tickNotices` / `pickNoticeForBubble` 用同一个时钟。 */
export interface NoticeContext {
  readonly now: number;
  /** 主窗口当前是否**有**焦点（`false` = 用户不在看）。部分规则拿它当判据。 */
  readonly windowFocused?: boolean;
}

/**
 * `turn:end` 升级为 `report` 的时长门槛。
 *
 * 取 90s 的依据在设计 §三：当日 205 个 turn 里，逐 turn 通知不可接受；而跑过一分半的
 * 那一轮，用户多半已经走开了，值得说一声「这一轮跑完了」。
 */
export const TURN_LONG_MS = 90_000;

/** `report` / `ambient` 的展示时长：到点自清（设计 §三）。 */
export const REPORT_TTL_MS = 30_000;

/**
 * 已销账条目在列表里再留多久。
 *
 * 设计只说「销账不是删除」（控制坞要能显示「已超时被拒」），没说留多久。取 5 分钟：
 * 够控制坞把结果展示给用户，又不至于让历史条目吃满容量。
 */
export const RESOLVED_KEEP_MS = 5 * 60 * 1000;

/** 通知列表容量。超出时淘汰**最老的已销账**条目（设计 §6.1 的「容量 200，FIFO 淘汰」）。 */
export const NOTICE_CAPACITY = 200;

/** `report` 限流：每会话 1 条/分钟（设计 §6.2）。 */
export const REPORT_PER_SESSION_MS = 60_000;

/** `report` 限流：全局 3 条/分钟（设计 §6.2）。 */
export const REPORT_GLOBAL_PER_MIN = 3;

/**
 * `pet-sensing` 的展示时长。**比 `report` 长**，理由是一次真机验证抓到的连锁：
 *
 * `report` 档要过"每会话 1 条/分钟"那道闸（{@link REPORT_PER_SESSION_MS}），
 * 而感知的会话键是**用户正在用的那条会话**——它刚刚冒出过一条"任务做完了"是常事
 * （实测间隔 13.5 秒）。这时感知那条会**排队等窗口放开**；
 * 可 30 秒的 TTL 比 60 秒的闸门短，它**等不到就走了**：既没冒气泡，当天配额又被花掉了。
 *
 * 2026-09-24 真机第一跑就是这个形态——日志里 `[runPetSensing] 说了一句` 有、气泡没有，
 * 而"要不要歇会儿"当天再也不会出现（同类当天限 1 次）。取
 * `REPORT_TTL_MS + REPORT_PER_SESSION_MS`：正好够它排过一次会话闸门
 * （全局 3 条/分钟那道更宽，顺带也过得去）。
 *
 * 代价是控制坞那行多挂一分钟。对"该歇会儿了"这种话，多留一会儿本来也更好
 * （第五期 T5.8 会把宠物流单独分区，那时再看要不要动）。
 */
export const SENSING_TTL_MS = REPORT_TTL_MS + REPORT_PER_SESSION_MS;

/** 权限气泡里 `description` 的截断长度——气泡只有两百来像素宽，中文一行约 12 字。 */
export const PERMISSION_DESC_MAX = 20;

/**
 * 免打扰时段（整点小时，跨午夜）。
 *
 * **与主动联系共用同一个窗口**（`main/agent-runtime/local-companion-handler.ts` 也读这两个常量）——
 * 那是"没人理我，我想说句话"，这里是"有事必须让你知道"，**两件事、两个计数器**，
 * 但"夜里别吵"这个判断只该有一处。
 */
export const QUIET_HOURS_START = 22;
export const QUIET_HOURS_END = 8;

/**
 * 此刻是否在免打扰时段。跨午夜安全（`start > end` 时按"或"判）。
 *
 * 只吃一个 `hour` 而不是 `Date`：**纯函数、可脱时区单测**，而且调用方本来就拿得到
 * 墙上时钟的小时（`new Date().getHours()`）——本模块其余部分用的是 `performance.now()`，
 * 两者不能混（前者是墙上时钟，后者是单调时钟）。
 */
export function isQuietHour(hour: number, start: number = QUIET_HOURS_START, end: number = QUIET_HOURS_END): boolean {
  if (!Number.isFinite(hour)) return false;
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  if (start === end) return false;
  if (start > end) return h >= start || h < end;
  return h >= start && h < end;
}

/** 气泡文案。硬编码在这里，将来接创作平台时整表替掉（与 `ANNOUNCE_TEXTS` 同一约定）。 */
export const NOTICE_TEXTS = {
  longTurn: "这一轮跑完了",
  askUser: "有个问题要你答",
  turnError: "出错了",
} as const;

/** `task_complete` 结果里没有 `summary` 时的兜底文案（有会话可跳，只是没摘要）。 */
export const TASK_COMPLETE_FALLBACK_TEXT = "任务做完了";

/**
 * 宠物目标回执没有文案时的两条兜底。
 *
 * 正常情况下宿主总会成句（宠物报的话本身就是内容），这两条是防"事件到了但 `text` 是空串"
 * ——**宁可说一句含糊的真话，也不要因为文案缺失而把回执整条吞掉**（用户交代的事，
 * 回执丢了比回执含糊严重得多，见设计 §4.2.2 F10）。
 *
 * 失败与成功**分开**：把失败说成"我去看过了"是撒谎，而一句"这次没做成"至少是诚实的。
 *
 * ⚠ 三条常量各有各的**可达条件**，不是三种写法说同一件事（2026-09-24 复查时它们
 * 在实际链路上都到不了，因为宿主只在"有正文"时才报成功、只在"没正文"时才报失败）：
 * - {@link PET_GOAL_FAILED_PREFIX}：失败**且有话说**（宿主带上失败原因）；
 * - {@link PET_GOAL_FAILED_FALLBACK}：失败且没话说；
 * - {@link PET_GOAL_FALLBACK_TEXT}：成功但没话说——宿主的不变量是"成功 ⇒ 有正文"，
 *   所以这条是**防御性分支**（pet-core 不能依赖宿主的不变量，事件里 `text` 是可选的）。
 */
export const PET_GOAL_FALLBACK_TEXT = "我去看过了";
export const PET_GOAL_FAILED_FALLBACK = "这次没做成";
/** 失败但有话说时的前缀（`ok === false`）——把"没成"这个事实摆在最前面 */
export const PET_GOAL_FAILED_PREFIX = "没能做成：";

export const TASK_COMPLETE_TOOL_NAME = "task_complete";

/**
 * 销账事件表：事件名 → 销账原因 + **只销哪一类**。
 *
 * 为什么要限定 `to`：两类通知的 `requestId` 各自生成，理论上不该撞号；但"用
 * `permission:granted` 销掉一条 ask-user 通知"在语义上是错的（回答了问题不可能产生审批结果），
 * 所以按类型各销各的，比单纯按 id 匹配更不容易误伤。
 *
 * `:prompt:` 变体必须一起收——审批走的是哪条通道（客户端弹窗 / 渠道文字 / 原生对话框）
 * 决定事件名，而**销账只认事件，不认处置来自哪个窗口**（设计 §四 清账表）。
 *
 * ⚠️ 缺口：`ask-user` 只有 `cancelled` 有事件，**用户回答后没有对应事件**
 * （响应走的是命令方向 `user:ask-user:respond`，主进程没有回广播）。所以"回答了"这条
 * 目前销不掉账——留 `answered` 这个 outcome 给将来补事件时用，别删。
 */
const RESOLVE_EVENTS: Readonly<
  Record<string, { readonly outcome: NoticeOutcome; readonly to: "permission" | "ask-user" }>
> = {
  "agent:permission:granted": { outcome: "granted", to: "permission" },
  "agent:permission:denied": { outcome: "denied", to: "permission" },
  "agent:permission:timeout": { outcome: "timeout", to: "permission" },
  "agent:permission:prompt:granted": { outcome: "granted", to: "permission" },
  "agent:permission:prompt:denied": { outcome: "denied", to: "permission" },
  "agent:permission:prompt:timeout": { outcome: "timeout", to: "permission" },
  "agent:permission:prompt:cancelled": { outcome: "cancelled", to: "permission" },
  "agent:ask-user:cancelled": { outcome: "cancelled", to: "ask-user" },
};

/**
 * 工具名 → 中文短语（气泡用）。
 *
 * ⚠️ 与 `apps/windows/src/renderer/components/ConfirmationDialog/ConfirmationDialog.tsx`
 * 的 `toolTitle()` 是**同一张表的两个副本**——pet-core 不能反向依赖 app 层，所以只能复制。
 * 改一处要改两处；将来可考虑把那张表收敛到这里。
 */
const TOOL_LABELS: Readonly<Record<string, string>> = {
  bash: "执行 Shell 命令",
  file_read: "读取文件",
  file_write: "写入文件",
  file_edit: "编辑文件",
  glob: "文件搜索",
  grep: "内容搜索",
  web_fetch: "网络请求",
  web_search: "网络搜索",
  todo_write: "更新任务列表",
  spawn_agent: "创建子 Agent",
  send_message: "发送消息",
};

/** 工具名的中文短语。MCP 工具按 `mcp__服务__方法` 拆开显示。 */
export function toolLabel(toolName: string): string {
  const known = TOOL_LABELS[toolName];
  if (known) return known;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcp) return `MCP ${mcp[1]} · ${mcp[2]}`;
  return `执行工具 ${toolName}`;
}

/** 按**码点**截断（emoji / 生僻字不会被切成半个），与 `announceDurationMs` 同一口径。 */
function truncateText(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return chars.slice(0, Math.max(1, max - 1)).join("") + "…";
}

/** FNV-1a 32 位。**只用来构造幂等键**，不做安全用途。 */
function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function sessionOf(event: NoticeEvent): string | null {
  const key = event.sessionKey;
  return key && key.trim() ? key : null;
}

/**
 * 一条事件 → 一条通知；不该产生时返回 `null`。
 *
 * 映射表（设计 §四）：
 *
 * | 事件 | 档 | 幂等键 | 文案 |
 * | --- | --- | --- | --- |
 * | `tool:end` 且 `toolName === 'task_complete'` 且非错 | `report` | `task:会话:摘要哈希` | 摘要本身 |
 * | `turn:end` 跑够久 / 用户发起后走开 | `report` | `turn:会话:轮次` | 「这一轮跑完了」 |
 * | `permission:request` / `:prompt` | `action` | `perm:请求id` | 工具中文名 + 说明 |
 * | `ask-user:request` | `action` | `ask:请求id` | 「有个问题要你答」 |
 * | `subagent:completed` 且 failed/stale | `report` | `sub:会话:名字` | 「{名字} 没跑成」 |
 * | `error` | 可重试 `ambient` / 否则 `report` | `err:会话:错误码` | 「出错了」 |
 * | `turn:file-changes`（主窗失焦且用户没参与） | `report` | `files:会话:轮次` | 「改了 N 个文件」 |
 * | `pet:goal:result`（宠物跑完用户交代的事） | `report` | `petgoal:会话:目标 id` | 宠物报的原话 |
 * | `pet:sensing`（宠物看着你说的一句话） | `report` | `sensing:会话:文案哈希` | 宿主成句的那句 |
 * | `tool:end` 出错 / `abort(user_cancel)` | `ambient` | — | — |
 *
 * 过程事件（`message:delta` / `thinking:delta` / `tool:start` / `tool:progress` /
 * `context:compacted`）**刻意不在表里**——它们走 `agentActivity`，不进这一维度。
 */
export function noticeFromEvent(event: NoticeEvent, ctx: NoticeContext): PetNotice | null {
  const now = sanitizeTimestamp(ctx.now, 0);
  const sessionKey = sessionOf(event);
  if (!sessionKey) return null;

  /**
   * **宠物自己那条会话上，只有回执值得播报。**
   *
   * 那条会话（`evolution:pet:<模型ID>`）是宠物干活的地方，用户在别处。它的
   * `agent:turn:end` 照样会发——而一次宠物目标动辄跑过 90 秒，于是 `turn:end`
   * 每跑一个目标就产出一条「这一轮跑完了」。问题不只是多一句话：
   *
   * 它**先于**回执到达（回执是 `waitForInstanceIdle` 之后才推的），而 `report` 档
   * 有"每会话 1 条/分钟"的额度（{@link REPORT_PER_SESSION_MS}）——额度被它吃掉，
   * 回执要等 60 秒才轮得到冒泡，可回执的 TTL 只有 30 秒（{@link REPORT_TTL_MS}）。
   * 净效果：**用户交代的事，回执永远冒不出来**（2026-09-24 复查发现）。
   *
   * 挡在这里而不是在宿主里：宿主判不出"这条会话属于宠物"之外的任何信息，
   * 而这条规则是纯粹的播报语义（与 `pet-sensing` 的会话正好相反——那条说的是**你**的会话）。
   *
   * ⚠ `agent:permission:*` 的销账不经过本函数，不受影响。
   */
  if (event.type !== "pet:goal:result" && isPetSessionKey(sessionKey)) return null;

  switch (event.type) {
    case "agent:tool:end": {
      // 失败的工具调用**先于** task_complete 判定：失败的 task_complete 不是"做完了"。
      // 单个工具失败 Agent 通常会自己重试，只记 ambient；真把一轮拖垮由 turn:end 接住。
      if (event.isError) {
        return {
          id: `toolerr:${sessionKey}:${event.toolName ?? "?"}:${Math.floor(now)}`,
          kind: "turn-error",
          level: "ambient",
          sessionKey,
          createdAt: now,
          text: NOTICE_TEXTS.turnError,
          ttlMs: REPORT_TTL_MS,
        };
      }
      if (event.toolName !== TASK_COMPLETE_TOOL_NAME) return null;

      const summary = event.summary?.trim();
      // 摘要只影响文案与幂等键，不影响能不能处置（跳会话只需要 sessionKey），
      // 所以缺摘要时用兜底文案 + 轮次当键，而不是丢掉这条通知。
      const key = summary
        ? hashText(summary)
        : event.turnIndex !== undefined
          ? `t${event.turnIndex}`
          : `at${Math.floor(now)}`;
      return {
        id: `task:${sessionKey}:${key}`,
        kind: "task-complete",
        level: "report",
        sessionKey,
        createdAt: now,
        text: summary || TASK_COMPLETE_FALLBACK_TEXT,
        deepLink: { to: "session" },
        ttlMs: REPORT_TTL_MS,
      };
    }

    case "agent:turn:end": {
      // 完成通知优先：同一轮里 task_complete 已经叫过一次，别再补一句"这一轮跑完了"。
      if (event.hasTaskComplete) return null;
      const durationMs = event.durationMs ?? 0;
      const ranLong = durationMs >= TURN_LONG_MS;
      // "用户发完就走开了"：由用户发起、而主窗已经失焦——那正是最该叫他回来看一眼的时刻
      const leftAfterAsking = event.userInitiated === true && ctx.windowFocused === false;
      if (!ranLong && !leftAfterAsking) return null;
      return {
        id: `turn:${sessionKey}:${event.turnIndex ?? Math.floor(now)}`,
        kind: "long-turn",
        level: "report",
        sessionKey,
        createdAt: now,
        text: NOTICE_TEXTS.longTurn,
        deepLink: { to: "session" },
        ttlMs: REPORT_TTL_MS,
      };
    }

    case "agent:permission:request":
    case "agent:permission:prompt": {
      // requestId 是回执与去审批的**唯一凭据**，缺了它这条通知点了也没用 → 不产生。
      if (!event.requestId) return null;
      /**
       * **已经被自动放行的不叫人**。
       *
       * 自动审批开着时（用户默认），`request` 与 `granted` 只隔 **3 毫秒**（实测）：
       * 通知会立刻被销账，气泡根本没机会冒出来——**而 shell 那层的系统通知是
       * "事件一到就发"，收不回来**。结果就是"宠物头上什么都没有，却弹了条
       * 『需要你确认』"，而事情早办完了。这不是少叫一次，是纯误报。
       */
      if (event.autoApproved === true) return null;
      const toolName = event.toolName ?? "";
      const desc = event.description?.trim();
      return {
        id: `perm:${event.requestId}`,
        kind: "permission",
        level: "action",
        sessionKey,
        createdAt: now,
        // **有 description 就用它，没有才退回工具中文名。**
        // 实测（`check-agent-notice.mjs` 首跑）：description 本身是自描述的
        //（bash 给的是「执行命令：node -e …」），再前缀一个工具中文名会得到
        // 「执行 Shell 命令：执行命令：…」——冗余，还把真正有用的命令挤到截断之外。
        text: desc ? truncateText(desc, PERMISSION_DESC_MAX) : toolName ? toolLabel(toolName) : "有个操作",
        deepLink: { to: "permission", requestId: event.requestId },
        // 本地超时兜底：审批 5 分钟不响应即 deny，到点标为已超时而不是一直挂着
        ...(event.timeoutMs !== undefined && event.timeoutMs > 0
          ? { timeoutAt: now + event.timeoutMs }
          : {}),
      };
    }

    case "agent:ask-user:request": {
      if (!event.requestId) return null;
      return {
        id: `ask:${event.requestId}`,
        kind: "ask-user",
        level: "action",
        sessionKey,
        createdAt: now,
        text: NOTICE_TEXTS.askUser,
        deepLink: { to: "ask-user", requestId: event.requestId },
      };
    }

    case "agent:subagent:completed": {
      // succeeded 不通知——主窗已经在做这件事，宠物再加一条是重复
      const status = event.subagentStatus;
      if (status !== "failed" && status !== "stale") return null;
      const name = event.subagentName?.trim() || "子 Agent";
      return {
        id: `sub:${sessionKey}:${name}`,
        kind: "subagent-failed",
        level: "report",
        sessionKey,
        createdAt: now,
        text: `「${truncateText(name, 12)}」没跑成`,
        deepLink: { to: "session" },
        ttlMs: REPORT_TTL_MS,
      };
    }

    case "agent:error": {
      // 可重试的错误会自动恢复，不该叫人；但仍然产生一条 ambient 记账（不进通道）
      const retryable = event.isRetryable === true;
      const code = event.errorCode ?? "unknown";
      return {
        id: `err:${sessionKey}:${code}`,
        kind: "turn-error",
        level: retryable ? "ambient" : "report",
        sessionKey,
        createdAt: now,
        text: NOTICE_TEXTS.turnError,
        // 可重试的不给处置入口——它不进通道，也就没人会去点
        ...(retryable ? {} : { deepLink: { to: "session" } as const }),
        ttlMs: REPORT_TTL_MS,
      };
    }

    case "agent:abort": {
      // 用户自己按的停止——回头再告诉他一次是噪音。timeout / error 才值得说。
      if (event.reason === "user_cancel") {
        return {
          id: `abort:${sessionKey}:${Math.floor(now)}`,
          kind: "turn-error",
          level: "ambient",
          sessionKey,
          createdAt: now,
          text: "已停止",
          ttlMs: REPORT_TTL_MS,
        };
      }
      return {
        id: `abort:${sessionKey}:${event.reason ?? "?"}:${Math.floor(now)}`,
        kind: "turn-error",
        level: "report",
        sessionKey,
        createdAt: now,
        text: NOTICE_TEXTS.turnError,
        deepLink: { to: "session" },
        ttlMs: REPORT_TTL_MS,
      };
    }

    case "agent:turn:file-changes": {
      // 只在"用户没参与、而且人不在"时补一句——否则主窗自己会显示变更
      if (ctx.windowFocused !== false || event.userInitiated === true) return null;
      const count = event.fileCount ?? 0;
      if (count <= 0) return null;
      const turnKey = event.turnIndex !== undefined ? String(event.turnIndex) : (event.messageId ?? "");
      return {
        id: `files:${sessionKey}:${turnKey}`,
        kind: "file-changes",
        level: "report",
        sessionKey,
        createdAt: now,
        text: `改了 ${count} 个文件`,
        deepLink: { to: "session" },
        ttlMs: REPORT_TTL_MS,
      };
    }

    case "pet:goal:result": {
      /**
       * 宠物替用户做完了一件事（三期 T3.5）。
       *
       * 档位取 `report` 而不是 `action`：**它不需要用户出手**——事情已经做完了，
       * 用户只是"顺便看一眼"。给它 `action` 就等于把"完成"变成一件待办，
       * 那正是设计 §十.1 里 D4 骚扰的定义（与 `task-complete` 取 `report` 同一条理由）。
       *
       * 文案直接用宿主成句后的 `summary`：宠物报的是"我看到了什么"，
       * 那句话本身就是内容，pet-core 不该改写它——**只负责在失败时加一句前缀**，
       * 因为"没做成"这件事必须让用户一眼看出来（设计 §7.1/F6：失败了要如实说）。
       */
      const body = event.summary?.trim();
      const failed = event.ok === false;
      const text = body
        ? failed
          ? `${PET_GOAL_FAILED_PREFIX}${body}`
          : body
        : failed
          ? PET_GOAL_FAILED_FALLBACK
          : PET_GOAL_FALLBACK_TEXT;
      return {
        /**
         * 幂等键取 **goalId**，不是文案哈希。
         *
         * 原判据是 `hashText(text)`，而失败文案（没有正文时）是个常量
         * （{@link PET_GOAL_FAILED_FALLBACK}）——第二次失败算出来的 id 与第一次**逐字相同**，
         * 于是被 `reduceNotices` 的"同 id 已存在就不产生"永久挡住：宠物连栽两次，
         * 用户只在第一次听见动静（相距不到 30 秒时连第一次都进不来）。
         * 用户交代的事必须件件有回音，所以键要落在**这一件事**上。
         *
         * 缺 `goalId` 时退回文案哈希：那样至少与旧行为一致，不会把重放防成两条。
         */
        id: `petgoal:${sessionKey}:${event.goalId?.trim() || hashText(text)}`,
        kind: "pet-goal",
        level: "report",
        // 办砸了要说得出是坏事——气泡冒出来时的庆祝粒子据此让位（见 `tone` 的注释）
        tone: failed ? "negative" : "positive",
        sessionKey,
        createdAt: now,
        text,
        deepLink: { to: "session" },
        /**
         * ⚠ **比 `report` 的 30 秒长**，与 `pet:sensing` 同一条理由（见 `SENSING_TTL_MS`）：
         * 它也要排过一次"每会话 1 条/分钟"的闸门才轮得到冒泡。
         *
         * 回执是**一件接一件**来的：用户一次点两件事、或一件办砸了又补一件，两次结局
         * 相隔几秒是常态（宠物跑一轮 3–10 秒）。第二条被闸门挡住要等到 60 秒，
         * 而 30 秒的 TTL 在 38 秒就把它清掉了 —— 用户只听见第一件的回音，
         * **第二件从此消失**（设计 §7.1/F6：用户交代的事必须件件有回音）。
         *
         * 上面 `turn:end` 那道闸只挡了宠物会话上的额度消耗，挡不住"同一分钟内两条回执"。
         */
        ttlMs: REPORT_TTL_MS + REPORT_PER_SESSION_MS,
      };
    }

    case "pet:sensing": {
      /**
       * 宠物看着你干活说的那句话（四期 T4.2/T4.3）。
       *
       * 档位 `report` 而不是 `action`，理由与 `pet-goal` 同：**不需要用户出手**。
       * 设计 §4.1.5 第 3 条要求它**只走气泡**（不做系统级通知）——`report` 正好只到
       * 气泡 + 控制坞，30 秒自清，不碰系统通知那条路。
       *
       * 文案直接用宿主成句后的 `summary`：那句话是宠物说的，pet-core 不改写它。
       * 判不出内容（空串）就**不产生**——感知类的话丢了就算了（设计 §4.2.2 的"说了没听见
       * 就算了"那一类），与 `pet:goal:result` 宁可含糊也不能吞**正好相反**：
       * 那是用户交代过的事，必须能回来看到。
       */
      const body = event.summary?.trim();
      if (!body) return null;
      return {
        id: `sensing:${sessionKey}:${hashText(body)}`,
        kind: "pet-sensing",
        level: "report",
        sessionKey,
        createdAt: now,
        text: body,
        // 跳回你刚才在干的那条会话——感知类的话没有可处置的东西，
        // 但"回到刚才"这个动作本身是合理的（点完就把主窗带回那条会话）
        deepLink: { to: "session" },
        // 有建议时那个按钮改成"让我去看看"（宿主侧的 noticeActionLabel 读它）
        ...(event.proposal?.description?.trim()
          ? { proposal: { description: event.proposal.description.trim() } }
          : {}),
        // ⚠ 比 `report` 的 30 秒长：它要排过一次会话闸门才轮得到冒泡，见 `SENSING_TTL_MS`
        ttlMs: SENSING_TTL_MS,
      };
    }

    default:
      return null;
  }
}

/** 把一条条目的销账信息写上去。**已经是销账态的不覆盖**（先到的事件说了算）。 */
function resolveNotice(notice: PetNotice, resolution: NoticeOutcome, at: number): PetNotice {
  if (notice.resolvedAt !== undefined) return notice;
  return { ...notice, resolvedAt: at, resolution };
}

/** 容量淘汰：只动**已销账**的（未销账的 `action` 必须一直挂着，见设计 §三）。 */
function enforceCapacity(list: readonly PetNotice[]): readonly PetNotice[] {
  if (list.length <= NOTICE_CAPACITY) return list;
  const overflow = list.length - NOTICE_CAPACITY;
  const removable = list
    .map((n, index) => ({ n, index }))
    .filter(({ n }) => n.resolvedAt !== undefined)
    .sort((a, b) => a.n.createdAt - b.n.createdAt || a.index - b.index)
    .slice(0, overflow);
  if (removable.length === 0) return list;
  const drop = new Set(removable.map(({ n }) => n.id));
  return list.filter((n) => !drop.has(n.id));
}

/**
 * 事件驱动的归约：**产生 + 销账 + 容量**。
 *
 * 无变化时返回原数组（引用不变）——宿主据此跳过重渲染，与 `reduceAgentActivity` 同一约定。
 *
 * ### 幂等靠"条目还在列表里"
 *
 * 同 id 已经在列表里（**包括已销账的**）就不再产生第二条。事件是可能重放的——
 * IPC 有队列、宠物窗口 `Page.reload` 会重新挂载订阅、主窗重连也会补发；
 * 没有这道闸，一次审批能叫三遍（设计 §6.1）。
 *
 * > 设计文档把这条写成"`announcedIds` 集合，容量 200 FIFO 淘汰"。这里用**列表本身**承担它：
 * > 条目在 `RESOLVED_KEEP_MS` 内都留着，重放窗口只有秒级，够用；也免得宿主再维护一个集合。
 */
export function reduceNotices(
  prev: readonly PetNotice[],
  event: NoticeEvent,
  ctx: NoticeContext,
): readonly PetNotice[] {
  const now = sanitizeTimestamp(ctx.now, 0);

  // 1) 销账：只认事件，不认处置来自哪个窗口
  const rule = RESOLVE_EVENTS[event.type];
  let next: readonly PetNotice[] = prev;
  if (rule && event.requestId) {
    const requestId = event.requestId;
    let touched = false;
    const resolved = prev.map((n) => {
      const matches = n.deepLink?.to === rule.to && n.deepLink.requestId === requestId;
      if (!matches) return n;
      const updated = resolveNotice(n, rule.outcome, now);
      if (updated !== n) touched = true;
      return updated;
    });
    if (touched) next = resolved;
  }

  // 2) 产生：同 id 已存在（含已销账）就不重复
  const produced = noticeFromEvent(event, ctx);
  if (produced && !next.some((n) => n.id === produced.id)) {
    next = [...next, produced];
  }

  // 3) 容量
  return enforceCapacity(next);
}

/**
 * 时间驱动的收尾。宿主在渲染循环或定时器里调用。
 *
 * 三件事，其余原样返回：
 * 1. `report`/`ambient` 的 TTL 到点 → **自清**
 * 2. `action` 未销账且 `timeoutAt` 到点 → **标为已超时**（保留条目，控制坞要显示"已超时被拒"）
 * 3. 已销账条目过了 `RESOLVED_KEEP_MS` → 自清
 */
export function tickNotices(prev: readonly PetNotice[], now: number): readonly PetNotice[] {
  const t = sanitizeTimestamp(now, 0);
  let changed = false;
  const next: PetNotice[] = [];

  for (const n of prev) {
    if (n.ttlMs !== undefined && t - n.createdAt >= n.ttlMs) {
      changed = true;
      continue;
    }
    if (n.timeoutAt !== undefined && n.resolvedAt === undefined && t >= n.timeoutAt) {
      next.push({ ...n, resolvedAt: n.timeoutAt, resolution: "timeout" });
      changed = true;
      continue;
    }
    if (n.resolvedAt !== undefined && t - n.resolvedAt >= RESOLVED_KEEP_MS) {
      changed = true;
      continue;
    }
    next.push(n);
  }

  return changed ? next : prev;
}

/** `report` 限流账本里的一条：哪条会话、什么时候冒的。 */
export interface NoticeReportStamp {
  readonly sessionKey: string;
  readonly at: number;
}

/**
 * 挑气泡时的限流账本与环境仲裁。**由宿主维护**，本模块只读。
 *
 * 全部可选——不传就是"没有任何历史、没有仲裁"，单测与首跑都用得上。
 */
export interface NoticeBubbleBudget {
  /** 幂等：已经冒过气泡的 notice id（与列表不是一回事——列表会被清空/淘汰） */
  readonly announcedIds?: ReadonlySet<string>;
  /** 同文案节流：文案 → 上次冒出的时刻 */
  readonly lastShownTextAt?: ReadonlyMap<string, number>;
  /** `report` 限流账本：最近的冒出记录（会话级 + 全局共用这一份） */
  readonly recentReports?: readonly NoticeReportStamp[];
  /** 免打扰时段（设计 §6.3）：`report` 吞掉、`action` 降级为不冒气泡 */
  readonly quietHours?: boolean;
  /** 用户正在跟宠物说话：`report` 推迟、`action` 插队（设计 §九） */
  readonly talkingWithUser?: boolean;
  /** 用户正在拖拽宠物：气泡一律不弹——别在这时弹待办（设计 §九）。系统通知不受影响。 */
  readonly beingDragged?: boolean;
}

function bubbleAllowed(notice: PetNotice, now: number, budget: NoticeBubbleBudget): boolean {
  if (budget.announcedIds?.has(notice.id)) return false;

  if (notice.level === "action") {
    // `action` 不受预算限制——真卡住就该叫（设计 §6.2），但幂等仍然管着它
    return true;
  }

  // `report`：同文案 10 分钟不重复 + 每会话 1 条/分钟 + 全局 3 条/分钟
  const lastText = budget.lastShownTextAt?.get(notice.text);
  if (lastText !== undefined && now - lastText < ANNOUNCE_THROTTLE_MS) return false;
  const recent = budget.recentReports ?? [];
  if (recent.some((r) => r.sessionKey === notice.sessionKey && now - r.at < REPORT_PER_SESSION_MS)) {
    return false;
  }
  const withinWindow = recent.filter((r) => now - r.at < REPORT_PER_SESSION_MS).length;
  if (withinWindow >= REPORT_GLOBAL_PER_MIN) return false;
  return true;
}

/**
 * 此刻该冒哪一条气泡；没有就返回 `null`。
 *
 * 排序与抢占（设计 §七）：
 * 1. **`action` 抢占 `report`**——被顶掉的 `report` 不重播（系统通知/控制坞已接住它）
 * 2. `action` 之间**按到达时间**排，不按主体会话优先（"卡住了"与是哪个会话无关）
 * 3. 同一会话有多条 `action` 时，取**最新**那条——老的往往已经被后续动作跨过
 * 4. `report` 之间按时间，先到先冒
 *
 * ⚠️ 会话来源（`source: 'other'`）由 UI 层根据 `sessionKey` 判断，不在本函数里——
 * pet-core 不知道"当前会话"是哪条（那是宿主的状态）。
 */
export function pickNoticeForBubble(
  notices: readonly PetNotice[],
  now: number,
  budget: NoticeBubbleBudget = {},
): PetNotice | null {
  const t = sanitizeTimestamp(now, 0);

  // 免打扰：report 直接吞掉，action 也不冒气泡（降级为头顶符号 + 控制坞 + 系统通知）
  if (budget.quietHours) return null;
  // 用户正在拖它玩——别在这时弹待办
  if (budget.beingDragged) return null;

  const pending = notices.filter((n) => n.resolvedAt === undefined && n.level !== "ambient");

  const actions = pending.filter((n) => n.level === "action");
  if (actions.length > 0) {
    // 同一会话取最新一条
    const latestPerSession = new Map<string, PetNotice>();
    for (const n of actions) {
      const cur = latestPerSession.get(n.sessionKey);
      if (!cur || n.createdAt >= cur.createdAt) latestPerSession.set(n.sessionKey, n);
    }
    // 会话之间按到达时间：各会话最早那条的 createdAt，先到先显示
    const earliestPerSession = new Map<string, number>();
    for (const n of actions) {
      const cur = earliestPerSession.get(n.sessionKey);
      if (cur === undefined || n.createdAt < cur) earliestPerSession.set(n.sessionKey, n.createdAt);
    }
    const ordered = [...latestPerSession.values()].sort((a, b) => {
      const ea = earliestPerSession.get(a.sessionKey) ?? a.createdAt;
      const eb = earliestPerSession.get(b.sessionKey) ?? b.createdAt;
      return ea - eb || a.createdAt - b.createdAt;
    });
    for (const n of ordered) {
      if (bubbleAllowed(n, t, budget)) return n;
    }
    return null;
  }

  // 用户正在跟它说话：`report` 推迟到对话结束（action 已经在上面插队走了）
  if (budget.talkingWithUser) return null;

  const reports = pending
    .filter((n) => n.level === "report")
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const n of reports) {
    if (bubbleAllowed(n, t, budget)) return n;
  }
  return null;
}

/**
 * 控制坞要列出来的条目：未销账、且不是 `ambient`。
 *
 * 排序：`action` 在前（等你出手的），组内按时间升序。设计 §七：多个 `action` 同时存在时，
 * 控制坞显示「N 件事等你」并展开列表。
 */
export function pendingNotices(notices: readonly PetNotice[]): readonly PetNotice[] {
  return notices
    .filter((n) => n.resolvedAt === undefined && n.level !== "ambient")
    .slice()
    .sort((a, b) => {
      if (a.level !== b.level) return a.level === "action" ? -1 : 1;
      return a.createdAt - b.createdAt;
    });
}
