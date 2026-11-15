/**
 * 排序加权 — 把 FTS5 的 bm25 候选重排成"用户想要的那个排第一"。
 *
 * 设计：`docs/design/逆向与复刻/2026-11-14-Listary复刻启动器插件设计.md` §6.3
 *
 * 纯函数，`now` 由调用方显式传入（不读 `Date.now()`），便于固定时间戳单测 ——
 * 与 `memory/scorer.ts` 的 `scoreMemory` 同一约定。
 *
 * ## 为什么不是"随便给几个权重"
 *
 * 每个权重的量级都由 §权重实测 的记录约束。改任何一项都要重跑评测集，
 * 不能凭手感调 —— 这是 `segmentation.ts` 里 848 条真实数据调参留下的规矩。
 *
 * ## 与记忆系统打分的关键差别（别照搬它的教训）
 *
 * `scoreMemory` 的注释记录了「自激」事故：recency 用 `lastUsedAt`，而它每次注入都被刷新，
 * 于是被注入的条目恒得满分、更易再被注入（9 条吃掉 54% 席位）。
 *
 * 这里**没有同样的风险**：`lz_usage` 只在用户**真的打开条目**时写（见 `recordUsage` 的调用点），
 * 查询本身不碰它。"越用越准"正是启动器想要的语义，不是副作用。
 * 但这条依赖「查询不写 usage」这个不变量 —— 改动调用点时别破坏它。
 */

/** 候选（已带 bm25 与使用历史），纯数据无 DB 依赖 */
export interface RankCandidate {
  readonly id: number
  readonly name: string
  readonly path: string
  readonly isStart: boolean
  readonly root: string
  /** FTS5 的 bm25，**负数，越小越相关**；LIKE 降级路径为 null */
  readonly bm25: number | null
  /** 该 keyword+path 的历史打开次数 */
  readonly usageCount: number
  /** 上次打开时间（epoch ms），0 表示从未 */
  readonly usageLastUsed: number
  /** 所属索引根的优先级（0..1），见 `rootPriority()` */
  readonly rootPriority: number
  /**
   * 字面命中（bigram 分词后能对上）为 true；仅拼音前缀命中为 false。
   *
   * 用来压制"拼音前缀召回"的副作用：查「文档」时 `我的设计稿`（首字母 `wdsjg`）
   * 因为以 `wd` 开头而被召回，但它是**撞上前缀**而非真匹配。
   * 字面命中的条目必须排在纯拼音命中之前。
   */
  readonly literalMatch: boolean
}

export interface RankWeights {
  /**
   * bm25 归一化后的权重。
   *
   * 用**饱和变换**（不是 min-max，见 `normalizeBm25One`）后，bm25 不再被拉满到 [0,1]，
   * 故不必为"给个性化留空间"而压低它 —— 相对差异天然温和，权重可以是最大的一项。
   */
  readonly bm25: number
  /** 文件名以查询词开头 */
  readonly namePrefix: number
  /** 文件名包含查询词（非开头） */
  readonly nameContains: number
  /** 使用频次：见 `USAGE_BONUS_CAP`（此字段保留用于将来按数据调比例，当前由常量决定） */
  readonly usage: number
  /** 最近使用（线性衰减到 0） */
  readonly recency: number
  /** 索引根优先级（Start Menu / 桌面 > 普通目录） */
  readonly root: number
  /** 路径深度惩罚（每深一层扣一点） */
  readonly depthPenalty: number
}

/**
 * 默认权重。
 *
 * 量级约定：**各项之和稍大于 1**，任一单项的绝对值即"它最多能贡献多少分"。
 *
 * 分配依据（都可在 §权重实测 找到支撑）：
 * 1. `bm25` = 0.9 —— 相关性最大，但**不占绝对主导**（饱和变换已让差距温和）
 * 2. `namePrefix` = 0.35 —— 起手打字时，前缀命中几乎就是要找的
 * 3. `usage` 封顶 0.25（`USAGE_BONUS_CAP`）—— "越用越准"，对数归一，不霸榜
 * 4. `root` = 0.18 —— Start Menu / 桌面的东西大概率是要启动的
 * 5. `nameContains` = 0.15 —— 只是"包含"，区分度低于前缀
 * 6. `recency` = 0.12 —— 比频次更弱：一次"上周刚用过"不如"用过十次"
 * 7. `depthPenalty` = 0.03 —— 只做同分时的微妙区分
 */
export const DEFAULT_WEIGHTS: RankWeights = {
  bm25: 0.9,
  namePrefix: 0.35,
  nameContains: 0.15,
  usage: 0.25,
  recency: 0.12,
  root: 0.18,
  depthPenalty: 0.03,
}

/**
 * 使用频次的封顶值。对数级增长，封顶避免"打开过 200 次"永久霸榜。
 *
 * **量级必须与 `weights.usage` 一起看**：实际加成是
 * `cap × min(1, log(1+count) / log(1+USAGE_REFERENCE_COUNT))`，
 * 即封顶值由 `cap` 决定、增长快慢由参考次数决定。
 *
 * 首版写成 `min(cap, weight * log(1 + count))` 并配 `weight = cap = 0.25`，
 * 实测在 `count = 2` 就触顶 —— 之后 10 次 / 100 次 / 1000 次全无差别，
 * "越用越准"只对头两次生效。故改为按参考次数归一。
 */
export const USAGE_BONUS_CAP = 0.25

/**
 * 达到满额加成的使用次数（对数曲线的参考点）。
 *
 * 取 20：`count = 1` 拿 23%、`5` 拿 62%、`20` 拿满。
 * 这个数字决定"用几次能顶到上限"，是最该按真实数据调的参数（见 §权重实测）。
 */
export const USAGE_REFERENCE_COUNT = 20

/** 最近使用的半衰期（天）。超过这个天数，recency 加成归零。 */
export const RECENCY_HALF_LIFE_DAYS = 30

/** 每个索引根的优先级（0..1）。未列出的根用 `DEFAULT_ROOT_PRIORITY`。 */
const ROOT_PRIORITY: ReadonlyArray<{ match: RegExp; value: number }> = [
  // 开始菜单的程序：用户搜出来几乎总是要启动
  { match: /\\start menu\\/i, value: 1.0 },
  // 桌面
  { match: /\\desktop\\/i, value: 0.9 },
  // 项目目录（用户主动加进来的根，库里 root 字段记的是根路径本身）
  { match: /./, value: 0.5 },
]

const DEFAULT_ROOT_PRIORITY = 0.4

/** 从路径推断根优先级。判定的是**条目所在路径**，不是 root 字段。 */
export function rootPriority(path: string): number {
  for (const { match, value } of ROOT_PRIORITY) {
    if (match.test(path)) return value
  }
  return DEFAULT_ROOT_PRIORITY
}

/**
 * 路径深度：盘符之后的**路径组件数**。
 *
 * `c:\` → 0、`c:\a` → 1、`c:\a\b` → 2。
 *
 * 首版数的是分隔符个数，于是 `c:\` 也算 1、与 `c:\a` 撞值 —— 根目录被平白罚了一层。
 */
export function pathDepth(path: string): number {
  const withoutDrive = path.replace(/^[a-z]:/i, '')
  return withoutDrive.split(/[\\/]/).filter((s) => s.length > 0).length
}

/**
 * bm25 饱和变换的拐点。`|bm25|` 等于它时得 0.5 分。
 *
 * 取值依据：SQLite FTS5 的 `bm25()` 返回负数、越小越相关，实际落在 |bm25| ≈ 0.3~20
 * 区间（随语料长度与词频变化）。取 k = 2 让常见的 1~5 段有区分度、极端值自然饱和。
 *
 * **这个数值不需要精确**——它只决定"多相关算满分"的刻度，不改变候选间的相对顺序
 *（函数在 |bm25| 上单调递增）。真要调，用 §权重实测 的评测集。
 */
export const BM25_SATURATION_K = 2

/**
 * bm25 → [0,1] 的单调变换（1 = 最相关）。
 *
 * **为什么不是 min-max 归一化**：首版用 min-max，它无条件把候选拉满到 `[0,1]`——
 * 两个真实相关性接近的候选（bm25 `-10` 与 `-9.9`）会被拉成 `1.0` 与 `0.0`，
 * 造出一个比真实差距大得多的假鸿沟。后果是使用历史/前缀这些个性化信号
 * **永远跨不过那个人为间隙**，"越用越准"成为摆设（实测：用过 50 次的仍排不过
 * 相关性略高但从未用过的）。
 *
 * 饱和变换保留相对差异：`-10` 与 `-5` → `0.833` 与 `0.714`，差 0.12 而非 1.0。
 *
 * `null`（LIKE 降级路径无 bm25）给 0。
 */
export function normalizeBm25One(value: number | null): number {
  if (value === null) return 0
  const mag = Math.abs(value)
  return mag / (mag + BM25_SATURATION_K)
}

/** 批量版本（保持与逐条相同的结果） */
export function normalizeBm25(values: readonly (number | null)[]): number[] {
  return values.map(normalizeBm25One)
}

/** 单个候选的打分。`bm25Norm` 由 `normalizeBm25` 预先算好。 */
export function scoreCandidate(
  c: RankCandidate,
  query: string,
  bm25Norm: number,
  now: number,
  weights: RankWeights = DEFAULT_WEIGHTS,
): number {
  const q = query.trim().toLowerCase()
  const name = c.name.toLowerCase()

  let score = weights.bm25 * bm25Norm

  if (q.length > 0) {
    if (name.startsWith(q)) score += weights.namePrefix
    else if (name.includes(q)) score += weights.nameContains
  }

  // 频次：对数级增长，按 USAGE_REFERENCE_COUNT 归一后乘 cap 封顶。
  // 对数压缩让"打开过 200 次"不会线性碾压"打开过 5 次"，但两者确实有差别。
  if (c.usageCount > 0) {
    const ratio = Math.min(1, Math.log(1 + c.usageCount) / Math.log(1 + USAGE_REFERENCE_COUNT))
    score += USAGE_BONUS_CAP * ratio
  }

  // 最近使用：线性衰减到 0
  if (c.usageLastUsed > 0) {
    const ageDays = Math.max(0, (now - c.usageLastUsed) / 86_400_000)
    score += weights.recency * Math.max(0, 1 - ageDays / RECENCY_HALF_LIFE_DAYS)
  }

  score += weights.root * c.rootPriority

  // 深度惩罚：只惩罚超出"常见层级"的部分，浅路径不扣
  const depth = pathDepth(c.path)
  if (depth > 3) score -= weights.depthPenalty * (depth - 3)

  return score
}

/**
 * 对一组候选排序。
 *
 * 排序键（从主到次）：
 * 1. **字面命中优先**（硬分层）—— 见 `RankCandidate.literalMatch`
 * 2. 综合分（bm25 + 前缀 + 使用历史 + 根优先级 + 深度）
 * 3. 同分时：Start Menu → 短路径 → path 字典序（最后一条保证输出可复现）
 */
export function rankCandidates(
  candidates: readonly RankCandidate[],
  query: string,
  now: number,
  weights: RankWeights = DEFAULT_WEIGHTS,
): RankCandidate[] {
  const scored = candidates.map((c) => ({
    candidate: c,
    score: scoreCandidate(c, query, normalizeBm25One(c.bm25), now, weights),
  }))

  scored.sort((a, b) => {
    if (a.candidate.literalMatch !== b.candidate.literalMatch) {
      return a.candidate.literalMatch ? -1 : 1
    }
    if (b.score !== a.score) return b.score - a.score
    if (a.candidate.isStart !== b.candidate.isStart) return a.candidate.isStart ? -1 : 1
    const da = pathDepth(a.candidate.path)
    const db = pathDepth(b.candidate.path)
    if (da !== db) return da - db
    // 最终兜底：按 path 字典序，保证结果确定（同分时输出可复现）
    return a.candidate.path.localeCompare(b.candidate.path)
  })

  return scored.map((s) => s.candidate)
}
