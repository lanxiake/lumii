/**
 * 记忆分段——纯函数基石（读写两侧共用），无副作用，便于单测。
 *
 * 设计：`.qoder/design/client-agent-runtime/2026-05-30-记忆系统升级-段落总结提取设计.md`
 *
 * 用途：
 * - 写侧：主题边界检测，判断对话段落何时关闭（`shouldCloseSegment`）
 * - 读侧：记忆相关性召回，计算 query 与记忆内容的关键词重叠（`overlapCoefficient`）
 *
 * 中文无空格，故用 **bigram（连续双字）** 分词而非标点切分；
 * 相似度用 **overlap 系数（交集/min）** 而非 jaccard，避免长文本被并集分母惩罚。
 * 同义不同词（"爬山"vs"登山"）的语义匹配留向量阶段（阶段③），本阶段不处理。
 */

/** CJK 统一表意文字范围（含扩展 A 常用区） */
const CJK_RE = /[㐀-䶿一-鿿]/;
/** 提取 token 段：CJK 连续串 或 拉丁字母/数字连续串（标点/空格作为分隔符被丢弃） */
const TOKEN_SEG_RE = /[㐀-䶿一-鿿]+|[a-z0-9]+/g;

/**
 * 把文本分词为 token 集合。
 * - CJK 连续串 → bigram（长度 1 时取单字）
 * - 拉丁/数字串 → 整词（小写）
 * 标点、空格、emoji 等被忽略。
 */
export function tokenizeBigram(text: string): Set<string> {
  const tokens = new Set<string>();
  if (!text) return tokens;
  const lower = text.toLowerCase();
  const matches = lower.match(TOKEN_SEG_RE);
  if (!matches) return tokens;

  for (const seg of matches) {
    if (CJK_RE.test(seg[0]!)) {
      if (seg.length === 1) {
        tokens.add(seg);
      } else {
        for (let i = 0; i < seg.length - 1; i++) {
          tokens.add(seg.slice(i, i + 2));
        }
      }
    } else {
      tokens.add(seg);
    }
  }
  return tokens;
}

/**
 * overlap 系数：|A∩B| / min(|A|,|B|)，范围 [0,1]。
 * 任一为空返回 0。
 */
export function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const t of small) if (large.has(t)) inter++;
  return inter / small.size;
}

/**
 * 相关性停用词（bigram / 英文词）：泛化的填充/动作/计划类词，几乎出现在任何 query 里，
 * 会造成"假相关"（如"规划路线"与"旅行规划中"共享"规划"）。算记忆相关性时剔除。
 * 不影响 tokenizeBigram（分段仍用全量，停用词对主题边界影响小）。
 */
const RELEVANCE_STOPWORDS: ReadonlySet<string> = new Set([
  // 填充/人称/助词
  "帮我", "帮忙", "我想", "我要", "我的", "我们", "你能", "能不", "不能", "可以", "麻烦",
  "我用", "我在", "给我", "一下", "一个", "一条", "一些", "这个", "那个", "这些", "那些",
  "之前", "现在", "已经", "还有", "什么", "怎么", "么样", "如何", "为什么",
  // 泛化动作/计划/整理
  "规划", "划一", "计划", "划中", "安排", "方案", "整理", "比较", "看看", "了解", "告诉",
]);

/**
 * 相关性专用分词：bigram 去除泛化停用词。用于记忆召回的 query↔内容相关性，
 * 避免泛化词制造假相关。
 */
export function tokenizeForRelevance(text: string): Set<string> {
  const tokens = tokenizeBigram(text);
  for (const sw of RELEVANCE_STOPWORDS) tokens.delete(sw);
  return tokens;
}

/** 段关闭原因 */
export type CloseReason = "time_gap" | "explicit_cue" | "capacity" | "topic_shift";

/** 主题边界判定所需的当前段状态 */
export interface SegmentBoundaryState {
  /** 段内最后一轮的时间戳（ms） */
  readonly lastTurnTs: number;
  /** 段内累积的主题 token（来自近 K 轮） */
  readonly topicTokens: Set<string>;
  /** 段内已有轮数 */
  readonly turnCount: number;
  /** 段内已累积字符数 */
  readonly charCount: number;
}

/** 即将到来的一轮 */
export interface IncomingTurn {
  readonly ts: number;
  readonly text: string;
}

/** 边界阈值配置（均可调） */
export interface BoundaryConfig {
  /** 时间间隔阈值（分钟），默认 20 */
  readonly gapMinutes?: number;
  /** 主题切换 overlap 下限，默认 0.08（越低越不易切，避免过度切段） */
  readonly overlapMin?: number;
  /** 段最大轮数，默认 12 */
  readonly maxTurns?: number;
  /** 段最大字符数，默认 4000 */
  readonly maxChars?: number;
  /** 主题切换检测的最小 token 数门槛（两侧都需达到才比较），默认 3 */
  readonly minTopicTokens?: number;
  /**
   * 段累积到多少轮后才允许 topic_shift 切段，默认 3。
   * 防止"连续同主题但用词不同的单轮"被反复误切成碎片段（over-segmentation）。
   * 容量/时间/显式线索不受此限制。
   */
  readonly minTurnsBeforeTopicShift?: number;
}

/** 显式话题切换线索 */
const EXPLICIT_CUES: readonly RegExp[] = [
  /换个?话题/,
  /说点别的/,
  /聊点别的/,
  /另外[，,、\s]/,
  /对了[，,、\s]/,
  /new\s+topic/i,
  /change\s+the\s+subject/i,
];

/**
 * 判断是否应在「当前段」与「即将到来的一轮」之间切段。
 *
 * 调用语义：observe 收到新一轮时，先用本函数判断是否关闭已有段
 * （若关闭，新一轮开启下一段）。判定基于**已有段状态**，不含本轮。
 *
 * 命中顺序（任一即返回）：时间间隔 → 显式线索 → 容量兜底 → 主题切换。
 * 返回 null 表示本轮并入当前段。
 */
export function shouldCloseSegment(
  state: SegmentBoundaryState,
  incoming: IncomingTurn,
  config: BoundaryConfig = {},
): CloseReason | null {
  const gapMinutes = config.gapMinutes ?? 20;
  const overlapMin = config.overlapMin ?? 0.08;
  const maxTurns = config.maxTurns ?? 12;
  const maxChars = config.maxChars ?? 4000;
  const minTopicTokens = config.minTopicTokens ?? 3;
  const minTurnsBeforeTopicShift = config.minTurnsBeforeTopicShift ?? 3;

  // 1. 时间间隔
  if (incoming.ts - state.lastTurnTs > gapMinutes * 60_000) return "time_gap";

  // 2. 显式线索
  if (EXPLICIT_CUES.some((re) => re.test(incoming.text))) return "explicit_cue";

  // 3. 容量兜底（已有段已达上限）
  if (state.turnCount >= maxTurns || state.charCount >= maxChars) return "capacity";

  // 4. 主题切换（仅当段已累积足够轮数 + 两侧 token 都够，避免单轮碎片化与短句噪声）
  if (state.turnCount >= minTurnsBeforeTopicShift) {
    const curTokens = tokenizeBigram(incoming.text);
    if (state.topicTokens.size >= minTopicTokens && curTokens.size >= minTopicTokens) {
      if (overlapCoefficient(curTokens, state.topicTokens) < overlapMin) return "topic_shift";
    }
  }

  return null;
}
