/**
 * 宠物替你去办事：**受理判断**（纯函数 + 只读，零副作用）
 *
 * 对应宠物智能化实施计划 T5.1（意图来源）与 T5.3（能力边界诚实化），
 * 设计 §4.2「能上场」与 §7「有限但真诚」。
 *
 * ---------------------------------------------------------------------------
 * 与 `pet-goals.ts` 的分工
 * ---------------------------------------------------------------------------
 * `pet-goals.ts` 是**派发侧**的只读层（"谁的宠物有活、到点了没、今天跑了几个"）。
 * 本模块是**受理侧**：用户点「让它去做」之后、目标落库之前的那个判断——
 * 「这件事接不接、不接怎么说」。两者都在宠物那条线上，但一个在入口、一个在出口，
 * 共用一张表却没有任何共享判据，所以分文件。
 *
 * ---------------------------------------------------------------------------
 * ⚠ T5.3 的原计划读 `capability_dimensions`，但那张表里**没有宠物的行**
 * ---------------------------------------------------------------------------
 * 计划原文：「读 `capability_dimensions` 的 Elo 边界；超出就直说"这个我不太拿手"」。
 * 2026-09-24 查真机库：那张表只有 `assistant`（4 维 / 138599 次测试）、
 * `chronicler`、`info-curator` 三个 agent，**`pet:*` 一行都没有**。
 * 而对不存在的行，`CapabilityTracker.getCapabilityState` 返回的是**缺省值**
 * `level: 0.5, confidence: 0`——那是"没测过"，不是"中等水平"。
 *
 * 两个后果：
 * 1. 直接读它会拿到一个**凭空捏造的边界**：宠物会凭这个 0.5 说出"我拿手 / 我不拿手"，
 *    而那句话背后没有任何一次真实经历。设计 §7.1 禁的是"让宠物假装什么都会，
 *    一次失败就露馅"——**反过来同样糟**：它并不知道自己会不会，却说得很确定。
 * 2. 借 `assistant` 的行当代理也不行：那是**另一个 Agent 的历史**，写进宠物的嘴里
 *    只是把"装作有"换了个姿势。
 *
 * 所以本模块读**宠物自己的行**，并且接受"第 0 天它没有行"这件事——
 * 见 {@link decidePetTask}：**样本不够就不判**，让它去试。边界是**挣来的**，
 * 不是出生时发的（与设计 §3「性格是出生抽的」相对：能力不是）。
 *
 * ---------------------------------------------------------------------------
 * 为什么"判不出就不判"
 * ---------------------------------------------------------------------------
 * {@link classifyPetRequest} 只看关键词、**只在唯一最高分时给答案**，并列或零命中
 * 一律返回 `null`。判错的形态是"宠物因为一件它其实没问题的事说我不太拿手"，
 * 而用户**无从分辨**——他没有那张表，也没有它的历史。宁漏不误伤。
 */

import { CapabilityDimension } from './types.js';

/**
 * 一次能说清的事有多长。
 *
 * 这不是能力上限，是**交互口径**：宠物做的是"一件事"，不是一份需求书。
 * 用户往输入框里贴一整段规格说明时，该被拦下的是**范围**而不是长度——
 * 所以拒绝文案说的是"挑其中一件告诉我"，不是"我读不了这么长的"。
 * （200 ≈ 一段话；`PET_PROMPT` 要求它三行内报回来，进来的是三行的几十倍就是没拆。）
 */
export const PET_TASK_MAX_CHARS = 200;

/**
 * 判"不拿手"之前至少要看过几次这类事。
 *
 * **低于它一律不拒**：一只刚出生的宠物不该张口就说不会——那是它最该去试的时候。
 * 而且 Elo 的前两步噪声极大（K=0.32，一次失败就从 0.5 掉到 0.34）。
 */
export const PET_TASK_MIN_SAMPLES = 4;

/**
 * 低于这条线才说"不拿手"。
 *
 * 与难度口径配套看（{@link PET_TASK_ASSUMED_DIFFICULTY}）：`level` 收敛到的是
 * **它在这类事上的成功率**，而 0.35 对应 `expectedPerformance(0.35, 0.5) ≈ 0.18`
 * ——十次里成不了两次，说"不拿手"是句实话。
 *
 * 0.5 是基线（没测过时的缺省），不设成 0.5 是因为那会让"低于平均"也算不拿手，
 * 而宠物**本来就该在平均线附近**——它是一只桌宠，不是专家系统。
 */
export const PET_TASK_WEAK_LEVEL = 0.35;

/**
 * 喂给 Elo 的难度取值。
 *
 * 取中性 0.5 ——**这是"不知道"，不是"中等偏上"**。真实难度要标注，而标注本身就得靠猜；
 * 编一个难度进去，`level` 就不再是"它成不成"，而变成"它成不成 × 我猜得准不准"。
 *
 * 取 0.5 的净效果正好是想要的：每次成功把 level 往上推、每次失败往下拉，
 * 收敛到 `它在这类事上的成功率`（经 Logistic 映射）。与 schema 里
 * `capability_dimensions.level` 的 DEFAULT 0.5 也是同一个数——同一个"未知"。
 */
export const PET_TASK_ASSUMED_DIFFICULTY = 0.5;

/** 拒绝：事情太大。见 {@link PET_TASK_MAX_CHARS} —— 口径是"范围"不是"长度" */
export const PET_TASK_TOO_LONG_REASON =
  '这像是一整件事，不像一件事。挑其中一件告诉我？';

/** 拒绝：能力边界（设计 §7.1 的原话，一字未改） */
export const PET_TASK_WEAK_REASON = '这个我不太拿手，要不要让主助手来？';

/** 拒绝：今天已经使唤够了（与派发侧 `checkPetGates` 的口径一致，但这里是**早退**） */
export function petTaskQuotaReason(runs: number, limit: number): string {
  return `今天已经使唤我 ${runs} 次了（上限 ${limit}），明天再派？`;
}

/** 拒复：同一条事还在排队/在跑，别重复派 */
export const PET_TASK_DUPLICATE_REASON = '这件事我已经在看了，等我回来。';

/**
 * 关键词 → 维度。
 *
 * 词表刻意短：长尾说法（"帮我看看这个"）本来就归不了类，硬塞只会先污染高频词。
 * 每个维度内的词**互不重叠**是有意的——重叠会让并列变多，而并列 = 不判（见文件头）。
 */
const DIMENSION_KEYWORDS: Readonly<Record<CapabilityDimension, readonly string[]>> = {
  [CapabilityDimension.CODE_GENERATION]: ['代码', '报错', '测试', '编译', '函数', 'bug', '堆栈', '脚本', '仓库'],
  [CapabilityDimension.DOCUMENT_ANALYSIS]: ['文档', '资料', '手册', '说明书', '需求', '摘要', '读一下'],
  [CapabilityDimension.WEB_SEARCH]: ['搜', '网上', '最新', '新闻', '官网', '百科', '查一下'],
  [CapabilityDimension.DATA_PROCESSING]: ['数据', '表格', '统计', '日志', '汇总', '图表', '清单'],
  [CapabilityDimension.API_INTEGRATION]: ['api', '接口', '密钥', '鉴权', '调用'],
  [CapabilityDimension.CREATIVE_WRITING]: ['文案', '起名', '取名', '故事', '宣传', '写一段'],
  [CapabilityDimension.LOGICAL_REASONING]: ['为什么', '推理', '分析一下', '哪个更好', '对比', '值不值'],
  [CapabilityDimension.MULTI_STEP_PLANNING]: ['计划', '排期', '步骤', '方案', '规划', '安排'],
};

/**
 * 一句话 → 它属于哪类事；**判不出返回 `null`**（并列也算判不出）。
 *
 * 大小写不敏感（`api` / `API` 都算），按**出现次数**计分——"测试"出现三次的那句话
 * 比顺带提一句"文档"的更该归到 code_generation。
 */
export function classifyPetRequest(text: string): CapabilityDimension | null {
  const haystack = text.toLowerCase();
  if (!haystack.trim()) return null;

  let best: CapabilityDimension | null = null;
  let bestScore = 0;
  let tied = false;

  for (const dimension of Object.keys(DIMENSION_KEYWORDS) as CapabilityDimension[]) {
    let score = 0;
    for (const keyword of DIMENSION_KEYWORDS[dimension]) {
      score += countOccurrences(haystack, keyword);
    }
    if (score === 0) continue;
    if (score > bestScore) {
      best = dimension;
      bestScore = score;
      tied = false;
    } else if (score === bestScore) {
      tied = true;
    }
  }

  return tied ? null : best;
}

/** 数一个子串出现几次（不用正则：关键词里可能有正则元字符，转义漏一个就是静默错判） */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/**
 * 宠物在一个维度上**真实测到**的边界。
 *
 * 没测过时调用方传 `null`，**不要传 `{ level: 0.5, testCount: 0 }`**——
 * 那两个字段是同一个意思（"不知道"），而 0.5 看起来像个答案。
 */
export interface PetTaskBoundary {
  /** `capability_dimensions.level`（0..1） */
  readonly level: number;
  /** `capability_dimensions.test_count` */
  readonly testCount: number;
}

/** 受理结论。拒绝时 `reason` 是**要给用户看的话**，直接进气泡与宠物流 */
export type PetTaskDecision =
  | { readonly accept: true; readonly dimension: CapabilityDimension | null }
  | { readonly accept: false; readonly reason: string };

/**
 * 接不接这件事。
 *
 * @param text    用户说的那句话（原样，不预处理）
 * @param boundary 宠物在**这件事所属维度**上的真实边界；判不出维度、或没有行 → `null`
 *
 * 两条判断，**顺序不能换**：
 * 1. 太长 → 先拦（它不需要知道任何历史就能判，而且拒的是**范围**）
 * 2. 边界弱 → 后拦（要有 {@link PET_TASK_MIN_SAMPLES} 次真实经历才生效）
 *
 * ⚠ 接受时也返回 `dimension`：受理侧要用它落进 `metadata`，
 * 跑完之后才知道该给哪个维度记一次成败（见 `PetTaskMetadata.dimension`）。
 * 判不出维度**不影响受理**——只是这件功劳/这笔账不记在任何一个维度上。
 */
export function decidePetTask(text: string, boundary: PetTaskBoundary | null): PetTaskDecision {
  const trimmed = text.trim();
  const dimension = classifyPetRequest(trimmed);

  if ([...trimmed].length > PET_TASK_MAX_CHARS) {
    return { accept: false, reason: PET_TASK_TOO_LONG_REASON };
  }

  if (
    boundary !== null &&
    boundary.testCount >= PET_TASK_MIN_SAMPLES &&
    boundary.level < PET_TASK_WEAK_LEVEL
  ) {
    return { accept: false, reason: PET_TASK_WEAK_REASON };
  }

  return { accept: true, dimension };
}

/**
 * 落到 `autonomous_goals.metadata` 的私有载荷（宠物这条线专用）。
 *
 * 复用那一列而不是新开一张表：`metadata` 本来就是自由 JSON 的**出处标记**
 * （真机库里现存 `{"source":"reflection-suggestion"}` / `{"plannedBy":"planner"}`
 * / `{"lowestDimension":…}` 三种写法），宠物只是第四种写法。
 *
 * 两个字段各有各的用处，都不是日志：
 * - `dimension`：跑完之后**给哪个维度记一次成败**（`recordPetTaskOutcome`）。
 *   受理时判一次就存下来，不在收尾时重算——重算会得到不同的答案（收尾时手上只有
 *   目标描述，而用户的原话可能已经不再是它了），于是"记的账"与"当时判的类"对不上。
 * - `result`：**控制坞宠物流那一行**的数据源（设计 §4.2.2：气泡是瞬时的，
 *   回执必须有持久条目）。气泡由 `pet:goal:result` 事件即时推，那一条会过期；
 *   这一条留在库里，用户倒水回来还看得到。
 */
export interface PetTaskMetadata {
  readonly source: 'pet-task';
  readonly dimension: CapabilityDimension | null;
  /**
   * 这件事是谁的主意（第七期 T7.4）：用户交代的，还是它自己排期找的。
   *
   * **缺省 `'user'`**：这个字段是后加的，存量行里没有它——而那些行全是用户
   * 交代的（那时宠物还不会自己找事做）。所以"没有这个字段"就等于 `'user'`，
   * 不需要回填迁移。
   */
  readonly origin?: 'user' | 'self';
  readonly result?: {
    readonly ok: boolean;
    readonly text: string;
    /** ISO 时刻。未读判定的游标是 `runtime_state` 里那个，这里只用于排序展示 */
    readonly at: string;
  };
}

/**
 * 回执正文的落库上限。
 *
 * `PET_PROMPT` 要求它三行内报回来，2000 是"三行"的几十倍——真撞上说明模型没守规矩。
 * 截断而不是丢弃：**回执宁可长一点也不能没有**（设计 §4.2.2）。
 * 完整原话另有去处：宠物自己那条会话的消息（`finishPetGoal` 写的），那才是权威副本。
 */
export const PET_TASK_RESULT_MAX_CHARS = 2000;

/** 解析 `metadata` 列。不是宠物任务、或 JSON 坏了 → `null`（调用方按"没有回执"处理） */
export function readPetTaskMetadata(raw: string | null | undefined): PetTaskMetadata | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PetTaskMetadata> | null;
    if (!parsed || parsed.source !== 'pet-task') return null;
    const dimension = parsed.dimension ?? null;
    const result = parsed.result;
    return {
      source: 'pet-task',
      dimension: dimension && dimension in DIMENSION_KEYWORDS ? dimension : null,
      origin: parsed.origin === 'self' ? 'self' : 'user',
      ...(result && typeof result.text === 'string' && typeof result.at === 'string'
        ? { result: { ok: result.ok === true, text: result.text, at: result.at } }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 * 构造落库用的 `metadata` 字符串（受理时调一次）。
 *
 * @param origin 这件事是谁的主意（第七期 T7.4）。`'user'` = 用户交代的，
 *   `'self'` = 它自己排期找的。缺省 `'user'`——存量行全是那个语义。
 *   经历页据此把"你让我做的"与"我自己想做的"分开说，而**两者走同一条执行链**
 *   （同一个单飞锁、同一个日闸门、同一个回执路径）：自己找事做不等于另开一条管道。
 */
export function buildPetTaskMetadata(
  dimension: CapabilityDimension | null,
  origin: 'user' | 'self' = 'user',
): string {
  const payload: PetTaskMetadata = { source: 'pet-task', dimension, origin };
  return JSON.stringify(payload);
}

/**
 * 把回执写进已有 `metadata`（收尾时调一次）。
 *
 * **保留原有字段**（尤其 `dimension`）：收尾时手上只有目标行，没有受理时的上下文，
 * 覆盖掉就等于把那次分类丢了。JSON 坏了也照写——回执比维度重要。
 *
 * `origin` 同一条理由：收尾时手上只有目标行，**别把它冲成默认的 `user`**
 * ——那会让一只自己找事做的宠物在经历页里变成"全是你让我做的"。
 */
export function withPetTaskResult(
  raw: string | null | undefined,
  ok: boolean,
  text: string,
  at: string,
): string {
  const existing = readPetTaskMetadata(raw);
  const payload: PetTaskMetadata = {
    source: 'pet-task',
    dimension: existing?.dimension ?? null,
    origin: existing?.origin ?? 'user',
    result: { ok, text: truncate(text, PET_TASK_RESULT_MAX_CHARS), at },
  };
  return JSON.stringify(payload);
}

/** 按**码点**截断（与 pet-core 的 `truncateText` 同一口径：emoji / 生僻字不切半个） */
function truncate(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return chars.slice(0, max).join('');
}

/**
 * 未读游标的 `runtime_state` 键（**按宠物分键**：两只宠物各有各的已读位置）。
 *
 * 为什么是**一个游标**而不是"每条回执一个已读标记"：用户看的是**宠物流这个列表**，
 * 不是逐条点开。游标表达"这个列表我看过了"，与手势一致；逐条标记还要为它多写 N 行。
 *
 * 键格式与写入都在这里定义一次（与 `pet-sensing.ts` 的 `petSensingSpokenKey` 同一约定：
 * 宿主不自己拼字符串）。读写由宿主做——本模块保持零 IO。
 */
export function petTaskReadCursorKey(agentId: string): string {
  return `pet.task.readAt:${agentId}`;
}
