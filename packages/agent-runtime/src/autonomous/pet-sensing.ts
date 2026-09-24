/**
 * 宠物感知层：读任务 Agent 已经产出的结果，判断**用户**现在怎么样
 * （纯读库，零副作用、零网络、零 token）
 *
 * 设计：docs/design/客户端UI/2026-09-23-宠物作为化身的智能化设计.md §4.1
 * 实施：docs/plans/客户端UI/2026-09-23-宠物智能化实施计划.md 第四期
 *
 * ---------------------------------------------------------------------------
 * 为什么**没有**复用 `collectTickSignals`（设计 §4.1.2 那张图的"同一份信号两个出口"）
 * ---------------------------------------------------------------------------
 * 核实过代码：两者的信号集**不相交**。`collectTickSignals` 回答的是"我（自主进化）
 * 该干点什么"——待执行目标、主动消息预算、反思/日记到期、token 用量、我自己的 mood。
 * 本模块回答的是"用户现在怎么样"——打断次数、连续坐了多久、会话评分、他在做什么。
 * 前者一个都不在后者里，后者也一个都不在前者里。
 *
 * 硬凑成同一个结构体的代价是明确的：那个结构体会变成两个消费者的并集，
 * 各自只读其中一半，而**字段增删时没有任何东西会提醒另一半**——本仓库已经有过
 * 一次"两个副本漂移"的教训（`notice.ts` 的 `TOOL_LABELS` 与 `ConfirmationDialog.toolTitle`）。
 *
 * 复用的是**形态**而不是结构体：一个只读的 `collect*` + 一个纯的 `decide*`，
 * 与 `tick-signals.ts` 同形；读 mood 走同一个 `readMood`。
 *
 * ⚠ **只复用读库判断，不复用它的派发语义**（设计 §4.1.2 末段）：宠物一旦要行动，
 * 走的是它自己的目标管道（`pet-goals.ts` + `pet-dispatch.ts`），不借用任务侧的心跳。
 *
 * ---------------------------------------------------------------------------
 * 三条预判规则（设计 §4.1.3）与它们的信号来源
 * ---------------------------------------------------------------------------
 * | 规则 | 信号 | 从哪读 |
 * |---|---|---|
 * | ① 打断 ≥3 次 → 靠近陪着 | abort / resend / edit 计数 | `runtime_state` 的 `feedback-log:*` |
 * | ② 连续坐 2h → 提醒休息 | 消息时间戳的连续性 | `messages` |
 * | ③ 会话评分低 → 写宠物自己的 mood | `overall_score < 0.6` | `autonomous_satisfaction_scores` |
 *
 * ## 规则①为什么不能直接用 `feedback:{会话}` 那个计数器
 *
 * `autonomous-feedback-signals.ts` 已经有一份计数，但它在**每个回合结束时被清零**
 * （`autonomous-wiring.ts` 的 `onTurnEnd` 消费掉它去算 `user_feedback`，随即 `resetCounters`）。
 * 后果是那个计数器**永远到不了 3**：打断一次 → 这一轮结束 → 归零 → 再打断一次 → 又是 1。
 * 所以规则①读的是同一处**另记一份、不被消费**的流水（`feedback-log:*`），
 * 它只带时间戳，由本模块按窗口数个数。
 *
 * ## 规则②为什么阈值不是设计里写的 5 分钟
 *
 * 实测（2026-09-24，本机真实库 1421 个相邻消息间隔）：
 *
 * | 间隔 | 条数 |
 * |---|---|
 * | < 1min | 848 |
 * | 1–5min | 313 |
 * | 5–15min | 114 |
 * | 15–60min | 75 |
 * | > 1h | 71 |
 *
 * 其中"用户发言 → 助手回复"的间隔（≈ 一个回合的时长）有 **61 / 889 超过 5 分钟、
 * 28 个超过 10 分钟**。取 5 分钟会把真实的长回合当成"用户离开了"，
 * 于是连着干活的用户**永远攒不满 2 小时**——那是静默失效，比误报更难发现。
 * 取 15 分钟：断开的仍然断开（午饭一小时、下班几小时都远超它），
 * 而长回合几乎不再误判。**这个数字要按同一张表继续量**，别当它是定论。
 */

import type { DatabaseAdapter } from '../storage/local-database.js';
import { moodToDecisionParams, readMood, type Mood } from './mood.js';

// ── 阈值（全部集中在这里，便于按实测曲线一处调） ──

/** 规则①的观察窗口：只看最近这段发生的打断 */
export const INTERRUPTION_WINDOW_MS = 30 * 60_000;
/** 规则①：窗口内打断/重发/编辑达到这个次数就靠近 */
export const INTERRUPTION_THRESHOLD = 3;

/** 规则②：连续工作多久算久坐 */
export const CONTINUOUS_WORK_MS = 2 * 60 * 60_000;
/** 规则②的放宽档：数据稀疏时宁可少说（设计 §4.1.6） */
export const CONTINUOUS_WORK_SPARSE_MS = 3 * 60 * 60_000;
/**
 * 规则②：空闲多久算**断开**，链条从下一段重新开始。
 *
 * 没有它会出现纯误报："11:00–12:00 干活、吃饭一小时、13:00 再干一小时"
 * 的时间戳跨度是 2 小时，会在**刚吃完饭时**弹"该休息了"。
 * 取 15 而不是设计原稿的 5 分钟，依据见文件头。
 */
export const IDLE_BREAK_MS = 15 * 60_000;
/** 规则②往回查多远：够得着放宽后的 3 小时阈值，再留一小时余量 */
export const CHAIN_LOOKBACK_MS = 4 * 60 * 60_000;

/** 规则③：低于这个分数，宠物跟着低落（设计 §4.1.3） */
export const LOW_SATISFACTION = 0.6;
/** 历史评分少于此数 = 数据稀疏 → 规则②走放宽档 */
export const SPARSE_SESSION_THRESHOLD = 5;

/** 一天最多说几次（全局）。两条规则各 1 次也正好是这个数 */
export const MAX_PET_SENSING_PER_DAY = 2;
/** **同类**一天不超过 1 次（设计 §4.1.5 第 2 条：说两遍就是唠叨） */
export const MAX_PET_SENSING_PER_KIND_PER_DAY = 1;

/**
 * 规则③写进宠物 mood 的事件名。
 *
 * **不复用 `task_failed`**：那是"我自己的任务失败了"。用户的会话不顺利是**它感知到的**
 * 一件事，两者混在一个计数器上，以后（T5.5）要把它自己的失败和为你难过分开时就分不开了。
 *
 * 影响按设计 §7.3：valence ↓（低落）**同时** arousal ↑（在意）——
 * 纯降 valence 会得到一个抑郁的、不再尝试的宠物。
 */
export const PET_MOOD_EVENT_STRUGGLING = 'user_struggling';

/** 预判种类。两种说法的克制纪律不同（见 `MAX_PET_SENSING_PER_KIND_PER_DAY`）。 */
export type PetSensingKind = 'interrupted' | 'tired';

/** 中文小时数（说到"三个多小时"就够，再往上不必精确） */
const HOUR_WORDS = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十'];

// ── 状态键（读写都在本模块，键就不会漂） ──

const STATE_PREFIX = 'pet.sensing.';

/**
 * 当天说过的次数（按种类），日界取**本地零点**——与 token / 目标配额同口径。
 *
 * ⚠ **键必须带 agentId**（2026-09-24 补）：mood / 性格 / 出生快照 / token 账
 * 全都按 `pet:<模型ID>` 分了，只有这两个键漏了。而"换模型 = 换宠物"是既有口径
 * （`petAgentId(configId)`），于是**切一次模型，新宠物当天的配额就被旧宠物吃掉了**。
 *
 * 键形与 `pet.task.readAt:<agentId>` / `autonomous.mood:<agentId>` 同一约定。
 * 老键（`pet.sensing.spoken:<日>`，无 agentId）**不做读时迁移**：真机上它从来是空的
 * （感知上线后没有任何一拍说过话），没有存量可分。
 */
export function petSensingSpokenKey(agentId: string, now: Date): string {
  const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
  return `${STATE_PREFIX}spoken:${agentId}:${day}`;
}

/**
 * 已经据此改过 mood 的那条评分 id——同一条评分只能让宠物低落一次。
 *
 * ⚠ 同 {@link petSensingSpokenKey}：**必须带 agentId**。不带的话，一只宠物消费了
 * 那条低分，另一只（切模型后的新宠物）就永远不会因它而低落——静默、且只在换宠物时出现。
 */
export function petSensingHandledScoreKey(agentId: string): string {
  return `${STATE_PREFIX}handled-score:${agentId}`;
}

// ── 信号 ──

/** 一条待说出口的预判 */
export interface PetSensingFinding {
  readonly kind: PetSensingKind;
  /** **已经可以直接展示的文案**：成句是宿主的事，pet-core 只负责放进气泡 */
  readonly text: string;
  /** 归到哪个会话：用用户当前在用的那条，点气泡时跳回去 */
  readonly sessionKey: string;
  /**
   * 这句话可以**派它去做**的一件具体事（五期 T5.1 的意图来源②，设计 §4.2.1）。
   *
   * 有它就说明这条气泡上的按钮不是"跳回会话"，而是"让我去看看"——
   * 用户点一下，它真的出门跑一趟（走 `pet-task-service` 那条受理 → 派发 → 回执）。
   *
   * ⚠ **只有在说得出一件具体的事时才有**（见 {@link proposalFor}）。
   * 说不出就不给这个出口：一个"要不要我去看看"而没有"看什么"的按钮，
   * 点下去宠物只能瞎翻，回来报一句不痛不痒的话——那比不给按钮更糟
   * （用户按了、等了、得到一句废话，下次就不按了）。
   */
  readonly proposal?: { readonly description: string };
}

/** 一次感知读到的全部信号 */
export interface PetSensingSignals {
  readonly now: number;
  /** 窗口内用户打断/重发/编辑的总次数 */
  readonly interruptions: number;
  /** 当前这条连续工作链已经持续多久（0 = 断链或没有数据） */
  readonly continuousWorkMs: number;
  /** 这条链在做什么（读沉淀得来，可能为 null） */
  readonly workTopic: string | null;
  /** 这条链最新的那个会话（气泡的落点） */
  readonly activeConversationId: string | null;
  /** 最近一条**用户会话**的评分（cron / 自主会话不算） */
  readonly lastSatisfaction: { readonly id: string; readonly score: number } | null;
  /** 历史上有过评分记录的**用户会话**条数——判冷启动与稀疏 */
  readonly scoredSessions: number;
  /** 宠物自己的 mood（不是助手的） */
  readonly petMood: Mood;
  /** 今天已说过的次数，按种类 */
  readonly spokenToday: Readonly<Record<PetSensingKind, number>>;
  /** 已经据此改过 mood 的那条评分 id（同一条评分只消费一次） */
  readonly handledScoreId: string | null;
}

/** 这一拍要做什么 */
export interface PetSensingDecision {
  /** 要不要冒一句（至多一条） */
  readonly speak: PetSensingFinding | null;
  /** 要不要改宠物自己的 mood；`shape` 是要落库的冲击事件名 */
  readonly moodEvent: { readonly event: string; readonly scoreId: string } | null;
  /** 为什么没说话（进日志，也是调阈值时的证据） */
  readonly reason: string;
}

// ── 读：用户侧 ──

/** 用户会话的前缀黑名单：后台会话不参与感知（宠物的会话也是后台） */
const NON_USER_SESSION_FILTER = `conversation_id NOT LIKE 'cron:%'
     AND conversation_id NOT LIKE 'evolution:%'
     AND conversation_id NOT LIKE 'pet:%'`;

/**
 * 规则①的信号：窗口内的打断流水条数。
 *
 * 只数**用户会话**（`feedback-log:*` 是按会话存的，宠物/自主会话被排除）。
 * 读不到就返回 0 —— 与 `countPetRunsToday` 同一条取舍：这是"限制"，
 * 读不到时放开比锁死安全（锁死会让规则①永远不触发，而且没人看得出来）。
 */
export function countRecentInterruptions(db: DatabaseAdapter, now: Date): number {
  const since = now.getTime() - INTERRUPTION_WINDOW_MS;
  try {
    const rows = db
      .prepare<{ key: string; value: string }>(
        `SELECT key, value FROM runtime_state WHERE key LIKE 'feedback-log:%'`,
      )
      .all();
    let count = 0;
    for (const row of rows) {
      const conversationId = row.key.slice('feedback-log:'.length);
      if (!isUserConversation(conversationId)) continue;
      count += parseFeedbackLog(row.value).filter((e) => e.at >= since).length;
    }
    return count;
  } catch {
    return 0;
  }
}

/** 后台会话（cron / 自主进化 / 宠物自己）不参与感知 */
function isUserConversation(conversationId: string): boolean {
  return (
    !conversationId.startsWith('cron:') &&
    !conversationId.startsWith('evolution:') &&
    !conversationId.startsWith('pet:')
  );
}

/** 流水里的时间戳解析失败按"不是最近"处理：脏数据不该把预判顶起来 */
function parseFeedbackLog(value: string): Array<{ at: number }> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((e) => (typeof e === 'object' && e !== null ? Number((e as { at?: unknown }).at) : NaN))
      .filter((at) => Number.isFinite(at))
      .map((at) => ({ at }));
  } catch {
    return [];
  }
}

/** 一条连续工作链 */
export interface WorkChain {
  /** 链条起点（epoch ms）；链断了或没数据时为 null */
  readonly startedAt: number | null;
  /** 链条里**最新**那条消息所属的会话 */
  readonly conversationId: string | null;
}

/**
 * 规则②的信号：往回走消息时间戳，遇到大于 {@link IDLE_BREAK_MS} 的空档就断链。
 *
 * 链条从**现在**往回走，而不是从最后一条消息——最后一条消息本身可能是几小时前的，
 * 那种情况链条早就断了，`startedAt` 必须是 null 而不是"上次那一整段"。
 *
 * 用 `messages.timestamp`（含助手消息）而不是只看用户消息：助手那边正在产出，
 * 说明人也还在（流式持久化每次都会把该行的 timestamp 推到当下，
 * 见 `conversation-repo.ts` 的注释），只看用户消息会把"等模型跑完"错判成离开了。
 */
export function readWorkChain(db: DatabaseAdapter, now: Date): WorkChain {
  try {
    const rows = db
      .prepare<{ conversation_id: string; timestamp: string }>(
        `SELECT conversation_id, timestamp FROM messages
          WHERE ${NON_USER_SESSION_FILTER}
            AND timestamp >= ?
          ORDER BY timestamp ASC`,
      )
      .all(new Date(now.getTime() - CHAIN_LOOKBACK_MS).toISOString());

    const stamped = rows
      .map((r) => ({ conversationId: r.conversation_id, at: new Date(r.timestamp).getTime() }))
      .filter((r) => Number.isFinite(r.at));
    if (stamped.length === 0) return { startedAt: null, conversationId: null };

    // 从最新往回走：最后一条消息离现在太远 → 人已经走了，不算连续
    let cursor = now.getTime();
    let startedAt: number | null = null;
    let latestConversationId: string | null = null;
    for (let i = stamped.length - 1; i >= 0; i -= 1) {
      const { at, conversationId } = stamped[i];
      if (cursor - at > IDLE_BREAK_MS) break;
      if (startedAt === null) latestConversationId = conversationId;
      startedAt = at;
      cursor = at;
    }
    return { startedAt, conversationId: latestConversationId };
  } catch {
    return { startedAt: null, conversationId: null };
  }
}

/**
 * 规则②的"带得出你在做什么"（设计 §4.1.4）：**读沉淀，不嗅探，不做推断**。
 *
 * 两个来源，都要求**机器可读的显式标记**，不解析自由文本的语义：
 *
 * 1. 这条会话**归属的项目**：`agent_memories.project_key` 经过 `source_message_id`
 *    回指到本会话的消息。这是别的 Agent 干活时留下的项目名，最贴合"你正在做什么"。
 *    ⚠ 读的是那一**列**，不是正文里的 `[project_key: …]` 写法——实测（2026-09-24）
 *    列上有 21 条、正文标记只剩 1 条，那个写法是历史遗留。
 * 2. 这条会话的**标题**（清理后，见 {@link cleanWorkTopic}）。
 *
 * ⚠ **工作记忆的正文刻意不用**：实测（近 14 天 351 条 `reference`）里 30 条是规划器的
 * `[pending] …` 噪声，`【…】` 那批是 "4nc5kx3 线 R71·真新事实一句话版" 这类内部代号。
 * 从那种文本里"提取主题"就是设计 §4.1.1 说的幻觉温床。
 *
 * 拿不到就返回 null，由调用方退回通用句——**宁可少说**（§4.1.6）。
 *
 * ⚠ **只读**：本函数不写任何东西回任务 Agent 的状态（设计 §4.1.4 权限边界）。
 */
export function readWorkTopic(db: DatabaseAdapter, conversationId: string | null): string | null {
  if (conversationId) {
    const fromProject = readProjectKey(db, conversationId);
    if (fromProject) return fromProject;
  }
  if (!conversationId) return null;
  try {
    const row = db
      .prepare<{ title: string | null }>(`SELECT title FROM conversations WHERE id = ?`)
      .get(conversationId);
    return cleanWorkTopic(row?.title ?? null);
  } catch {
    return null;
  }
}

/** 本会话归属的项目名（`project_key` 列，经来源消息回指到会话） */
function readProjectKey(db: DatabaseAdapter, conversationId: string): string | null {
  try {
    const row = db
      .prepare<{ project_key: string }>(
        `SELECT m.project_key FROM agent_memories m
           JOIN messages msg ON msg.id = m.source_message_id
          WHERE msg.conversation_id = ?
            AND m.project_key IS NOT NULL AND m.project_key <> ''
          ORDER BY m.created_at DESC LIMIT 1`,
      )
      .get(conversationId);
    return cleanWorkTopic(row?.project_key ?? null);
  } catch {
    return null;
  }
}

/**
 * 会话标题 → 能嵌进句子的短语；**看不准就返回 null**。
 *
 * 会话标题是"这句话题目"，本来就是给用户看的一句话，直接塞进
 * 「你在弄「X」吧」里，遇到 `请用 Read 工具读取 appsw…` 这种（标题就是被截断的
 * 第一句用户话）会得到一句怪话。所以这里**只做减法**：
 *
 * 1. 截到第一个标点之前（标题常常是「google封号，正常使用，写一个申…」这种；
 *    `·` / `/` 也算——「像素流水线 · 走路帧」的头是更像话题的「像素流水线」）
 * 2. 太短/太长的丢掉（2–12 个码点）
 * 3. 看起来是**请求**或**招呼**的丢掉（`请` / `帮我` / `你好` 这类开头）
 * 4. 含链接、`@`、路径、换行的丢掉
 *
 * 偏保守是**故意**的：判错的代价是一句怪话，判不出退回通用句几乎没代价
 * （与 §4.1.6「感知没料时不要硬说」同一条）。
 * 这份名单来自 2026-09-24 对真实标题的逐条核对，不够就继续加——
 * 但**不要**改成"猜语义"。
 */
export function cleanWorkTopic(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // 链接 / 提及 / 路径 / 换行：一眼不是话题，而且**必须先判**——
  // 它是按标点切之前的事，否则 `https://…` 会先被切成 `https`
  if (/https?:|www\.|@|\\|\/|\n/.test(trimmed)) return null;

  const head = (trimmed.split(/[，,。；;：:!！?？·／|]/)[0] ?? '').trim();
  const stripped = head.replace(/[.．…\s]+$/, '');
  const chars = [...stripped];
  if (chars.length < 2 || chars.length > 12) return null;

  const OPENERS = [
    '你好', '您好', '嗨', '哈喽', '在吗', 'hello', 'hi',
    '请', '帮', '麻烦', '给我', '来', '去', '把', '用', '停', '别', '不',
    '研究', '看', '查', '测试', '试', '改', '写', '做',
  ];
  const lower = stripped.toLowerCase();
  if (OPENERS.some((o) => lower.startsWith(o))) return null;
  return stripped;
}

/**
 * 规则③的信号：最近一条**用户会话**的评分。
 *
 * 过滤掉 `cron:*` / `evolution:*`：那些会话每天自动跑几十轮，它们的评分低
 * 与"用户今天干得不顺"毫无关系，而且会把真正的低分挤到窗口外。
 */
export function readLatestSatisfaction(
  db: DatabaseAdapter,
): { id: string; score: number } | null {
  try {
    const row = db
      .prepare<{ id: string; overall_score: number }>(
        `SELECT id, overall_score FROM autonomous_satisfaction_scores
          WHERE session_id NOT LIKE 'cron:%'
            AND session_id NOT LIKE 'evolution:%'
            AND session_id NOT LIKE 'pet:%'
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get();
    if (!row) return null;
    return { id: row.id, score: row.overall_score };
  } catch {
    return null;
  }
}

/**
 * 历史上有过评分记录的**用户会话**条数（不是评分条数——一条会话几十轮）。
 *
 * 冷启动（0）与数据稀疏（< {@link SPARSE_SESSION_THRESHOLD}）都靠它判。
 */
export function countScoredUserSessions(db: DatabaseAdapter): number {
  try {
    const row = db
      .prepare<{ count: number }>(
        `SELECT COUNT(DISTINCT session_id) as count FROM autonomous_satisfaction_scores
          WHERE session_id NOT LIKE 'cron:%'
            AND session_id NOT LIKE 'evolution:%'
            AND session_id NOT LIKE 'pet:%'`,
      )
      .get();
    return row?.count ?? 0;
  } catch {
    // 读不到就当**冷启动**：这条读不到时，"少说"比"多说"安全
    return 0;
  }
}

// ── 宠物侧的状态读写 ──

/** 今天已说过的次数（按这只宠物） */
export function readSpokenToday(
  db: DatabaseAdapter,
  agentId: string,
  now: Date,
): Record<PetSensingKind, number> {
  const empty = { interrupted: 0, tired: 0 };
  try {
    const row = db
      .prepare<{ value: string }>(`SELECT value FROM runtime_state WHERE key = ?`)
      .get(petSensingSpokenKey(agentId, now));
    if (!row?.value) return empty;
    const parsed = JSON.parse(row.value) as Partial<Record<PetSensingKind, number>>;
    return {
      interrupted: Number(parsed.interrupted) || 0,
      tired: Number(parsed.tired) || 0,
    };
  } catch {
    return empty;
  }
}

/** 记一次"说过了"（记在这只宠物自己账上）。写失败只影响当天配额，不该打断感知。 */
export function recordSpoken(
  db: DatabaseAdapter,
  agentId: string,
  kind: PetSensingKind,
  now: Date,
): void {
  const next = readSpokenToday(db, agentId, now);
  next[kind] += 1;
  db.prepare(
    `INSERT INTO runtime_state (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(petSensingSpokenKey(agentId, now), JSON.stringify(next), new Date().toISOString());
}

/** 已经据此改过 mood 的那条评分 id（按这只宠物） */
export function readHandledScoreId(db: DatabaseAdapter, agentId: string): string | null {
  try {
    const row = db
      .prepare<{ value: string }>(`SELECT value FROM runtime_state WHERE key = ?`)
      .get(petSensingHandledScoreKey(agentId));
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export function writeHandledScoreId(db: DatabaseAdapter, agentId: string, scoreId: string): void {
  db.prepare(
    `INSERT INTO runtime_state (key, value, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(petSensingHandledScoreKey(agentId), scoreId, new Date().toISOString());
}

// ── 收集 + 决策 ──

/**
 * 收集一次感知信号。纯读库，不写任何状态。
 *
 * `petAgentId` 是**宠物的**身份（`pet:<模型ID>`）——读它自己的 mood，不是助手的。
 */
export function collectPetSensingSignals(
  db: DatabaseAdapter,
  petAgentId: string,
  now: Date = new Date(),
): PetSensingSignals {
  const chain = readWorkChain(db, now);
  return {
    now: now.getTime(),
    interruptions: countRecentInterruptions(db, now),
    continuousWorkMs: chain.startedAt === null ? 0 : now.getTime() - chain.startedAt,
    workTopic: readWorkTopic(db, chain.conversationId),
    activeConversationId: chain.conversationId,
    lastSatisfaction: readLatestSatisfaction(db),
    scoredSessions: countScoredUserSessions(db),
    petMood: readMood(db, petAgentId, now.getTime()),
    spokenToday: readSpokenToday(db, petAgentId, now),
    handledScoreId: readHandledScoreId(db, petAgentId),
  };
}

/**
 * 纯决策：信号 → 这一拍做什么。**没有副作用**（说出口与改 mood 都由宿主执行）。
 *
 * 优先顺序：规则①（当场卡住）> 规则②（坐太久）。两者都要过配额，
 * **而且都过不了"宠物自己心情差"这一关**——它蔫的时候话变少，
 * 正是验收「会话评分低 → 主动说话概率降低」要的东西，而且是**真的**
 * 由它自己的 mood 推出来的，不是演的。
 *
 * ⚠ mood 那一项**不看配额**：它不是"说话"，是"它的状态"。
 * 但同一条评分只消费一次（`handledScoreId`），否则每一拍都会再低落一点。
 */
export function decidePetSensing(signals: PetSensingSignals): PetSensingDecision {
  const moodEvent = decideMood(signals);
  const speak = decideSpeak(signals);
  return {
    speak,
    moodEvent,
    reason: speak ? `speak:${speak.kind}` : noSpeakReason(signals),
  };
}

/** 规则③：低分只在**第一次看到这条评分**时改 mood */
function decideMood(signals: PetSensingSignals): PetSensingDecision['moodEvent'] {
  const score = signals.lastSatisfaction;
  if (!score) return null;
  if (score.id === signals.handledScoreId) return null;
  if (!(score.score < LOW_SATISFACTION)) return null;
  return { event: PET_MOOD_EVENT_STRUGGLING, scoreId: score.id };
}

/**
 * 规则①②谁说、说什么。
 *
 * 冷启动（一条历史评分都没有）**一条都不说**：设计 §4.1.6「无历史数据时退回性格驱动的
 * 自发行为，不硬说」。这一段其实很短——用户跑完第一轮就有了第一条评分——
 * 所以直接静默的代价极小，而"新装的宠物上来就点评你"的代价很大。
 */
function decideSpeak(signals: PetSensingSignals): PetSensingFinding | null {
  if (signals.scoredSessions === 0) return null;
  if (!signals.activeConversationId) return null;

  // 它自己蔫着就少说。上限 2 → 蔫的时候 1（`moodToDecisionParams` 给的 0.5）。
  // 取整用 floor 而不是四舍五入：宁可少说一句。
  const budget = Math.floor(
    MAX_PET_SENSING_PER_DAY * moodToDecisionParams(signals.petMood).outreachMultiplier,
  );
  const spokenTotal = signals.spokenToday.interrupted + signals.spokenToday.tired;
  if (spokenTotal >= budget) return null;

  const sessionKey = signals.activeConversationId;
  const allowed = (kind: PetSensingKind) =>
    signals.spokenToday[kind] < MAX_PET_SENSING_PER_KIND_PER_DAY;

  if (signals.interruptions >= INTERRUPTION_THRESHOLD && allowed('interrupted')) {
    const proposal = proposalFor(signals.workTopic);
    return {
      kind: 'interrupted',
      text: INTERRUPTED_TEXT,
      sessionKey,
      ...(proposal ? { proposal } : {}),
    };
  }

  const threshold =
    signals.scoredSessions < SPARSE_SESSION_THRESHOLD ? CONTINUOUS_WORK_SPARSE_MS : CONTINUOUS_WORK_MS;
  if (signals.continuousWorkMs >= threshold && allowed('tired')) {
    return {
      kind: 'tired',
      text: tiredText(signals.continuousWorkMs, signals.workTopic),
      sessionKey,
    };
  }
  return null;
}

/**
 * 规则①那句话可以附带的那件事（五期 T5.1②）。
 *
 * **它手上只有"看"的工具**（`PET_TOOL_ALLOWLIST`：搜索 / 读文件 / 翻资料库 / 查记忆），
 * 所以这件事必须落在那几样里。取"翻资料和记忆"而不是"看看你的代码哪里有 bug"：
 * 后者听起来更像人话，但它只能靠 grep 猜，回来的多半是废话——
 * 而前者是它**真的能做完**的一件事（`memory_search` + `wiki_search` 是它的本行）。
 *
 * ⚠ **说不出主题就不给建议**（返回 null）。`workTopic` 是从沉淀里读的
 * （`readWorkTopic`），读不到时（没建项目记忆、或那条链上没有）与其说
 * "要不要我去看看"，不如只说"要不要歇会儿"——设计 §4.1.5 的克制那一条。
 */
function proposalFor(workTopic: string | null): { description: string } | null {
  const topic = workTopic?.trim();
  if (!topic) return null;
  return { description: `查一下「${topic}」相关的资料和我记过的东西` };
}

/**
 * 没说话的原因（进日志）。
 * 这一段是**调阈值唯一的证据来源**：阈值的量法就是"连着几天看这些话"，
 * 所以它必须把当场那几个数报出来，而不是只说一句"没说"。
 */
function noSpeakReason(signals: PetSensingSignals): string {
  if (signals.scoredSessions === 0) return 'cold-start: 还没有任何会话评分，沉默';
  if (!signals.activeConversationId) return 'no-work-chain: 没有连续工作链';
  return (
    `quiet: interruptions=${signals.interruptions}/${INTERRUPTION_THRESHOLD}` +
    ` workMs=${Math.round(signals.continuousWorkMs / 60_000)}min` +
    ` spoken=${signals.spokenToday.interrupted + signals.spokenToday.tired}/${MAX_PET_SENSING_PER_DAY}`
  );
}

// ── 文案（硬编码在这里，将来接创作平台时整表替掉，与 `NOTICE_TEXTS` 同一约定） ──

/**
 * 规则①的文案。
 *
 * 用设计 §4.1.3 的原话「要不要歇会儿」而不是"检测到你打断了很多次"：
 * 报告次数是**监视感**，而这句话的重点是"过来陪你"，不是"我在统计你"。
 * 也刻意**不带问号之外的追问**——设计 §4.1.5 第 1 条：猜错了不追问，等下次信号。
 */
export const INTERRUPTED_TEXT = '要不要歇会儿';

/**
 * 规则②的文案。有主题就用主题（"X 弄了两个多小时了"），没有就退回通用句。
 *
 * ⚠ 括号里的主题是**只读**来的（会话标题 / project 记忆的项目名），
 * 不做任何语义推断——推断出来的"你在重构前端"就是设计 §4.1.1 说的幻觉温床。
 */
export function tiredText(continuousWorkMs: number, topic: string | null): string {
  const hours = Math.max(2, Math.floor(continuousWorkMs / 3_600_000));
  const word = HOUR_WORDS[Math.min(hours, HOUR_WORDS.length - 1)];
  return topic
    ? `你在弄「${topic}」吧，${word}个多小时了，起来走两步？`
    : `坐${word}个多小时了，起来走两步？`;
}
