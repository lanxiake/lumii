/**
 * ToolLoadout — 按 (agent, channel) 的历史决定「常驻哪 20 个工具、其余折叠」。
 *
 * 设计依据：`docs/design/能力面治理/…设计.md` §5.6.4 三行规则。
 * 初稿的六项加权公式被回放实测推翻（3174 条真实消息，纯 LRU 93.5% @ N=20 vs 公式 90.6%），
 * 所以这里**只有**排序 = 最近使用时间降序。不衰减、不加权、**不看次数**
 * ——频率项已被证伪为负增益，谁再往里加权重就是把它重新发明回去。
 *
 * 作用域必须是 `(agentDefinitionId, channel)`：`evolution` 那类 Agent 用全局热度排
 * Recall 会掉到 32%（§5.6.3(a)）。调用方负责传对 `lastUsed`（见 `bridge-instance-factory`
 * 里按实例渠道解析的那一段），这里不做分组——纯函数不认识 agent 是谁。
 *
 * **fail-open 是硬约束（计划 C8）**：宁可多花 8K token，也不能让模型「不会用」某个工具。
 */

export interface ToolLoadoutInput<T> {
  /** 候选工具（已按 Agent 定义过滤、已排除用户禁用） */
  readonly all: readonly T[]
  /**
   * 该 (agent, channel) 的工具 → 最后使用时刻（epoch ms）。
   * 来自 `tool_usage_stats` 的渠道切片；**空表示冷启动**。
   */
  readonly lastUsed: ReadonlyMap<string, number>
  /** 恒在且不占名额的工具名（`tool_search` / `task_complete` / `skill_search`） */
  readonly pinned: readonly string[]
  /** 非 pinned 的常驻名额，默认 20（§5.6.4 的 N 曲线在 20 附近变平） */
  readonly limit: number
}

export interface ToolLoadout<T> {
  /** 本轮发给模型的工具（pinned + LRU 前 limit 个） */
  readonly loaded: readonly T[]
  /** 折叠进 `tool_search` 的其余工具（**仍可一次检索取回**） */
  readonly deferred: readonly T[]
}

/** 无历史时 `lastUsed.get()` 的落点：比任何真实时间戳都小，故排最后 */
const NO_HISTORY = -1

/**
 * 三行规则 + 两条 fail-open。
 *
 * 冷启动判据是「**`all` 里没有任何一个工具有历史**」而不是「`lastUsed` 为空」：
 * 后者在同 Agent 换过渠道、或表里只剩已删除工具时会误判，然后把一批随机工具当常驻。
 */
export function resolveToolLoadout<T extends { name: string }>(
  input: ToolLoadoutInput<T>,
): ToolLoadout<T> {
  const { all, lastUsed, pinned } = input
  const limit = Math.max(0, input.limit)

  // ── fail-open ①：冷启动 → 全量（C8）──
  // 首次使用某工具只占 3.3% 的调用（§5.6.3(b)），所以这个分支很少走到，
  // 但它是零成本的安全网：新 Agent 第一次跑绝不能因为「没历史」而只拿到 search。
  //
  // **注意这里只判「一条历史都没有」**。判「历史够不够多」是另一件事，且不能按工具条数判：
  // 一个稳定只用 12 个工具的渠道恰恰是最好的折叠对象（保留 12、折 138），
  // 按条数拦会把这类渠道永久关在门外。真信号是**渠道数据够不够老**
  // （渠道维度是后加的，刚上线的渠道计数天然偏低）——那个判据在宿主侧做，
  // 因为纯函数拿不到日期（见 `resolveInitialLoadout` 的 MIN_CHANNEL_HISTORY_DAYS）。
  if (!all.some((t) => lastUsed.has(t.name))) {
    return { loaded: all, deferred: [] }
  }

  const pinnedSet = new Set(pinned)
  const loaded: T[] = all.filter((t) => pinnedSet.has(t.name))
  const deferred: T[] = []

  // 最近使用降序；没历史的排最后，同刻按名字排保证确定性（否则每轮顺序抖动，
  // 会让 pi 的 toolsAdded/toolsRemoved 差集每次都不为空，白写系统消息）。
  const rest = all
    .filter((t) => !pinnedSet.has(t.name))
    .map((tool) => ({ tool, ts: lastUsed.get(tool.name) ?? NO_HISTORY }))
    .sort((a, b) => b.ts - a.ts || a.tool.name.localeCompare(b.tool.name))

  for (let i = 0; i < rest.length; i++) {
    // pinned 不占名额（C8 / §5.6.4 规则 2）
    if (i < limit) loaded.push(rest[i]!.tool)
    else deferred.push(rest[i]!.tool)
  }

  return { loaded, deferred }
}

/**
 * 把「折叠名单」落成最终发给模型的工具集。
 *
 * **必须在 Agent 定义过滤之后调用**（调用方传进来的 `allowedTools` 应是 `filterToolsByDefinition` 的结果）。
 * 顺序反了会静默删能力：先裁再过滤，白名单会把折掉的部分再扫一遍，而白名单窄的 Agent
 * （chronicler 只认 10 个）会连自己要的工具一起没。
 *
 * `ensure` 里的名字若不在 `allowedTools` 里，从 `pool` 补回——`tool_search` 是折叠的唯一出口，
 * 而多数 Agent 的白名单里根本没有它（强塞等于改它的能力面，但它与灰度名单同时出现，故可接受）。
 */
export function applyToolLoadout<T extends { name: string }>(opts: {
  /** 已按 Agent 定义过滤的工具 */
  readonly allowedTools: readonly T[]
  /** `resolveToolLoadout` 的结果；null = 不裁 */
  readonly deferred: readonly T[] | null
  /** 补回 `ensure` 用名的来源（通常是全量 `allTools`） */
  readonly pool: readonly T[]
  /** 必须恒在的名字（`tool_search`）。缺了就折叠等于删除 */
  readonly ensure?: readonly string[]
}): { loadedTools: T[]; deferredTools: T[] } {
  const loaded = [...opts.allowedTools]
  for (const name of opts.ensure ?? []) {
    if (loaded.some((t) => t.name === name)) continue
    const found = opts.pool.find((t) => t.name === name)
    if (found) loaded.push(found)
  }
  if (!opts.deferred?.length) return { loadedTools: loaded, deferredTools: [] }
  const folded = new Set(opts.deferred.map((t) => t.name))
  return {
    loadedTools: loaded.filter((t) => !folded.has(t.name)),
    deferredTools: [...opts.deferred],
  }
}
