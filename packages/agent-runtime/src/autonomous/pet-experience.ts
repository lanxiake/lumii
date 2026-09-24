/**
 * 宠物的经历流水：用户对它的反应（第七期 T7.1）
 *
 * ---------------------------------------------------------------------------
 * 为什么需要它
 * ---------------------------------------------------------------------------
 * 闭环（设计 §12.2）的四段里，三段已经有数据：经历 = 目标与结果
 * （`autonomous_goals` + 宠物会话）、演进 = 人格事件表。**唯独「用户理不理它」
 * 一处都没有**——宠物说了一句话、做了一件事，没有任何地方记录用户是否理会。
 *
 * 而它恰恰是演进最需要的原料：**一个没人理的宠物与一个被互动的宠物，
 * 该长成两种样子**。没有这条流水，"会变"就只能靠目标自己的成败，
 * 那长出来的是个项目经理，不是一只宠物。
 *
 * ---------------------------------------------------------------------------
 * 为什么是 runtime_state 的有上限流水，不是新表
 * ---------------------------------------------------------------------------
 * 照 `feedback-log:<会话>` 那套（`autonomous-feedback-signals.ts`）：
 * 反思只需要**近期**这几十条，长期历史已经在 `autonomous_goals` 与宠物会话里；
 * 而「经历」Tab 要展示的三项（出生 / 性格变化 / 做过的事）都不依赖这张流水。
 * 为几十条的环形缓冲配一次表迁移 + 清理 + 索引，不值。
 *
 * 这也是「经历」这项设计**唯一的全新数据**——其余都只是接线。
 *
 * ---------------------------------------------------------------------------
 * 六条信号，一条新交互都不加
 * ---------------------------------------------------------------------------
 * 全部是**已经在发生的事**（设计 §12.3 那张表）：
 *
 * | kind | 发生在哪 | 说明 |
 * |---|---|---|
 * | `bubble-click` | 气泡上的按钮 | 最强的正面：用户真的动身了 |
 * | `bubble-ignored` | 气泡撤下时 | **沉默也是信号**（唯一需要新埋的点） |
 * | `task-read` | 控制坞打开时 | 它说的话被看见了 |
 * | `chat-reply` | 控制坞输入框 | 用户在跟**它**说话 |
 * | `task-created` | 「让它去做」 | 又交给它一件事 = 信任 |
 * | `petted` | 点它 / 摸头 / 拖拽 | 中等的亲近 |
 *
 * 刻意**不为了让宠物"有素材"而给用户加任何新交互**——那会让"它有经历"
 * 变成"用户要付出更多"。
 */

import type { DatabaseAdapter } from '../storage/local-database.js';
import { RuntimeStateRepo } from '../storage/runtime-state-repo.js';
import { readPetTaskMetadata } from './pet-task.js';

/**
 * 用户做了什么（只记事实，不记判分——见文件头）。
 *
 * 名单是**运行时值**（不只是类型）：IPC 那头要在写库前校验渲染层传来的字符串，
 * 而那种校验一旦靠手抄的字符串数组，就会出现"类型说六种、校验认五种"这种事
 * ——多出来的那种静默丢弃，表现是某条信号永远不产生。同源就不可能有这个分歧。
 */
export const PET_EXPERIENCE_KINDS = [
  'bubble-click',
  'bubble-ignored',
  'task-read',
  'chat-reply',
  'task-created',
  'petted',
] as const;

export type PetExperienceKind = (typeof PET_EXPERIENCE_KINDS)[number];

/** 校验一个来路不明的值是不是已知信号（IPC 边界用） */
export function isPetExperienceKind(value: unknown): value is PetExperienceKind {
  return typeof value === 'string' && (PET_EXPERIENCE_KINDS as readonly string[]).includes(value);
}

/** 键前缀；按 agent 分（每只宠物各记各的账，理由同 mood 分键） */
const PET_EXPERIENCE_KEY_PREFIX = 'pet.experience:';

/** 保留窗口：7 天。反思是日频的，一周足够看出"最近它跟这个人处得怎么样" */
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** 条数上限：200。一天几十条互动已经是很黏的用户了，再多也轮不到 */
const MAX_ENTRIES = 200;

export interface PetExperienceEntry {
  /** 发生了什么 */
  k: PetExperienceKind
  /** 毫秒时间戳 */
  at: number
}

export function petExperienceKey(agentId: string): string {
  return `${PET_EXPERIENCE_KEY_PREFIX}${agentId}`;
}

/**
 * 读这只宠物的经历流水（新的在后）。读不到返回空数组。
 *
 * 读失败按"没有经历"处理：反思与沉浸都不该因为一条流水读不出来而中断，
 * 而空数组在下游的自然语义就是"最近什么都没发生"（正是冷启动守卫要的）。
 */
export function readPetExperience(db: DatabaseAdapter, agentId: string): PetExperienceEntry[] {
  try {
    const raw = new RuntimeStateRepo(db).get(petExperienceKey(agentId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is PetExperienceEntry =>
          typeof e === 'object' &&
          e !== null &&
          typeof (e as { k?: unknown }).k === 'string' &&
          Number.isFinite(Number((e as { at?: unknown }).at)),
      )
      .map((e) => ({ k: e.k, at: Number(e.at) }))
      .sort((a, b) => a.at - b.at);
  } catch {
    return [];
  }
}

/**
 * 追加一条经历。剪枝（超 7 天 / 超 200 条）与写入同一次完成。
 *
 * **不抛错**：这是旁路的旁路（用户的点击 → 记一条痕迹），
 * 写失败绝不能影响用户那一下操作本身。与 `recordFeedbackSignal` 同一条约定。
 */
export function appendPetExperience(
  db: DatabaseAdapter,
  agentId: string,
  kind: PetExperienceKind,
  now = new Date(),
): void {
  try {
    const at = now.getTime();
    const entries = readPetExperience(db, agentId);
    entries.push({ k: kind, at });
    const kept = entries.filter((e) => at - e.at <= KEEP_MS).slice(-MAX_ENTRIES);
    const repo = new RuntimeStateRepo(db);
    repo.set(petExperienceKey(agentId), JSON.stringify(kept));
  } catch {
    /* 记一条痕迹失败不该影响用户那一下操作 */
  }
}

/**
 * 流水的**解读视图**——供反思与演进使用。
 *
 * ⚠ 存储那一侧只记"发生了什么"（见文件头），正负是**这里**的判读。
 * 放在读侧的好处是改判据不用迁移数据；坏处是判据会散——所以只有这一处，
 * 反思与 `user-feedback-*` 事件都从它取，不各写各的。
 */
export interface PetExperienceSummary {
  /** 被回应的次数（正面信号总数） */
  positive: number
  /** 被冷落的次数（气泡挂了没人理） */
  ignored: number
  /** 互动**种类**（不是次数）——"它今天被摸过也被派过活"比"今天互动 7 次"有信息量 */
  kinds: PetExperienceKind[]
  /** 窗口内最近一次互动距现在多久（毫秒）；一次都没有时 `null` */
  sinceLastMs: number | null
  /** 窗口内总条数 */
  total: number
}

/** 判为"正面"的信号（见文件头那张表；`bubble-ignored` 是唯一不在此列的） */
const POSITIVE_KINDS: ReadonlySet<PetExperienceKind> = new Set<PetExperienceKind>([
  'bubble-click',
  'task-read',
  'chat-reply',
  'task-created',
  'petted',
]);

/**
 * 把流水压成一句可读的"最近它跟你处得怎么样"。
 *
 * @param windowMs 只看这个窗口内的（默认 72 小时：日频反思看的是"这几天"，
 *   再长的记忆由人格状态自己承担——它本来就是经历的累积）
 */
export function summarizePetExperience(
  entries: readonly PetExperienceEntry[],
  now = new Date(),
  windowMs = 72 * 60 * 60 * 1000,
): PetExperienceSummary {
  const nowMs = now.getTime();
  const recent = entries.filter((e) => nowMs - e.at <= windowMs);
  let positive = 0;
  let ignored = 0;
  for (const e of recent) {
    if (e.k === 'bubble-ignored') ignored++;
    else if (POSITIVE_KINDS.has(e.k)) positive++;
  }
  const last = recent.length > 0 ? recent[recent.length - 1] : null;
  return {
    positive,
    ignored,
    kinds: [...new Set(recent.map((e) => e.k))],
    sinceLastMs: last ? nowMs - last.at : null,
    total: recent.length,
  };
}

/**
 * 「了解」的 `runtime_state` 键。
 *
 * 与记忆**两份**，各有用处，不是重复：
 * - 这里那份是**给下一次反思做上下文**的（"我上次说他是这样的人，要改口还是接着说"），
 *   要的是同步、便宜、一定有；
 * - 记忆那份是**长期的**（能被检索、能被别的会话读到），走 `agent_memories`。
 *
 * 只写记忆的话，反思读回来要过一遍检索（慢且不一定命中）；只写这里的话，
 * 这份了解就只活在反思的提示词里，用户永远看不到它"记住了什么"。
 */
export function petUnderstandingKey(agentId: string): string {
  return `pet.understanding:${agentId}`;
}

/** 读上次反思说的"我对你的了解"；没有返回 `null` */
export function readPetUnderstanding(db: DatabaseAdapter, agentId: string): string | null {
  try {
    const raw = new RuntimeStateRepo(db).get(petUnderstandingKey(agentId));
    return raw && raw.trim().length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** 记下这次的"我对你的了解"（下一轮反思会读到它并要求自己改口或延续） */
export function writePetUnderstanding(
  db: DatabaseAdapter,
  agentId: string,
  text: string,
): void {
  try {
    new RuntimeStateRepo(db).set(petUnderstandingKey(agentId), text);
  } catch {
    /* 记不住只是下次反思少了连续性，不该影响别的 */
  }
}

/** 「做过的事」的一条（形状与 `PetReflectionExperience` 一致，可直接喂给反思） */
export interface PetWorkRecord {
  id: string;
  description: string;
  ok: boolean;
  at: string;
  /** 结果摘要；没有回执时缺省 */
  result?: string;
}

/**
 * 读它**做过的事**——经历的另一半（设计 §12.2 那张表的第一行）。
 *
 * 判据取 `planned_by = 'pet'`（用户交代的与自己找的都是它），再用
 * `readPetTaskMetadata` 精筛：SQL 的 `LIKE` 只是便宜预筛，真正的判据是那个解析器
 * （与 `pet-task-store.listRows` 同一条纪律）。
 *
 * **只取已收尾的**：正在路上的还没有"结果"可言，把它塞给反思会让它对着
 * 一件没做完的事下结论。
 *
 * 读失败返回空数组 —— 下游（反思）据此走冷启动分支，正是"没有经历就不反思"。
 */
export function readPetWorkRecords(
  db: DatabaseAdapter,
  agentId: string,
  limit = 10,
): PetWorkRecord[] {
  try {
    const rows = db
      .prepare<{
        id: string;
        description: string;
        status: string;
        completed_at: string | null;
        created_at: string;
        metadata: string | null;
      }>(
        `SELECT id, description, status, completed_at, created_at, metadata
           FROM autonomous_goals
          WHERE agent_id = ? AND planned_by = 'pet' AND status IN ('completed', 'failed')
          ORDER BY COALESCE(completed_at, created_at) DESC
          LIMIT ?`,
      )
      .all(agentId, limit);
    const works: PetWorkRecord[] = [];
    for (const row of rows) {
      const meta = readPetTaskMetadata(row.metadata);
      if (!meta) continue;
      works.push({
        id: row.id,
        description: row.description,
        // 终态是权威：回执缺失时按目标状态判（回执写库失败不该让它变成"没做过"）
        ok: meta.result?.ok ?? row.status === 'completed',
        at: meta.result?.at ?? row.completed_at ?? row.created_at,
        ...(meta.result?.text ? { result: meta.result.text } : {}),
      });
    }
    return works;
  } catch {
    return [];
  }
}
