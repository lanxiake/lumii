/**
 * 渠道身份：会话「归属哪个渠道」的唯一来源（10-S2）
 *
 * 背景：此前「sessionKey → 渠道」有 5 套实现、全靠 id 前缀推断。而前缀只说明会话
 * **从哪来**，不说明此刻**谁在说话**——同一个 `qbot:` 键会被微信适配器服务
 * （2026-09-15 日志实证，见 docs/plans/专项Agent/10-渠道会话路由重构.md §2.1）。
 *
 * 本模块把「归属」变成显式数据：`conversations.channel_type`（V41 迁移建立并回填）。
 * 前缀推断只保留两条用途：
 *   1. 存量行回填（迁移）；
 *   2. 落库值缺失时的回退（老库、测试桩、尚未写入的新会话）。
 * **「此刻谁在说话」永远取 adapter 的 `channelType`，不从键推断**——这是本模块与
 * 「当前路由」的分工边界（路由见 `channel-session-store.ts`）。
 */

/**
 * 会话归属。
 *
 * `ipc` = 客户端本地会话（含被 `/link` 绑定的那些——绑定是**路由**，不改归属）；
 * `cron` / `evolution` / `onboarding` = 系统会话（不进接续候选、不出现在 /resume、不可转移）。
 */
export type ChannelOwnership =
  | 'ipc'
  | 'weixin'
  | 'feishu'
  | 'wecom'
  | 'qbot'
  | 'cron'
  | 'evolution'
  | 'onboarding'

/** 系统会话归属（非用户会话） */
export const SYSTEM_OWNERSHIPS: ReadonlySet<ChannelOwnership> = new Set([
  'cron',
  'evolution',
  'onboarding',
])

/**
 * 前缀 → 归属。**只用于回填与回退**，运行期不要拿它当渠道判定。
 *
 * 顺序即匹配顺序；未命中即为 `ipc`（客户端会话是裸 conversationId，无前缀）。
 */
const OWNERSHIP_BY_PREFIX: ReadonlyArray<readonly [string, ChannelOwnership]> = [
  ['weixin', 'weixin'],
  ['feishu', 'feishu'],
  ['wecom', 'wecom'],
  ['qbot', 'qbot'],
  ['cron', 'cron'],
  ['evolution', 'evolution'],
  ['onboarding', 'onboarding'],
]

/**
 * 归属 → 中文名（全仓唯一一份）。
 *
 * `ipc` 固定为「客户端」（用户视角的默认渠道）；系统会话返回空串——
 * 既有消费方（`/resume` 列表、接续候选）正是靠「空标签」把它们排除在外。
 */
const OWNERSHIP_LABELS: Readonly<Partial<Record<ChannelOwnership, string>>> = {
  weixin: '微信',
  feishu: '飞书',
  wecom: '企业微信',
  qbot: 'QQ',
}

/** 是否为已登记的归属值（读库时校验，避免脏值污染判定） */
export function isChannelOwnership(value: unknown): value is ChannelOwnership {
  if (typeof value !== 'string') return false
  if (value === 'ipc') return true
  return OWNERSHIP_BY_PREFIX.some(([prefix]) => prefix === value)
}

/** 前缀回退：从会话 id 反推归属（**仅迁移期与缺失落库值时使用**） */
export function channelOwnershipFromKey(conversationId: string): ChannelOwnership {
  const prefix = conversationId.split(':')[0] ?? ''
  for (const [p, ownership] of OWNERSHIP_BY_PREFIX) {
    if (prefix === p) return ownership
  }
  return 'ipc'
}

/** 是否系统会话（cron / evolution / onboarding） */
export function isSystemOwnership(ownership: string): boolean {
  return SYSTEM_OWNERSHIPS.has(ownership as ChannelOwnership)
}

/** 归属的中文名；系统会话与未知值为空串 */
export function channelLabelOfOwnership(ownership: string): string {
  if (ownership === 'ipc') return '客户端'
  return OWNERSHIP_LABELS[ownership as ChannelOwnership] ?? ''
}

export interface ChannelIdentity {
  ownership: ChannelOwnership
  /** 中文名：渠道名 / 「客户端」/ 空串（系统会话） */
  label: string
}

/**
 * 解析会话归属。
 *
 * @param conversationId 会话 id
 * @param stored `conversations.channel_type` 落库值（**有就信它**，这是本重构的要点）。
 *   传 `null`/`undefined` 或脏值时回退前缀推断。
 */
export function resolveChannelIdentity(
  conversationId: string,
  stored?: string | null,
): ChannelIdentity {
  const ownership = isChannelOwnership(stored) ? stored : channelOwnershipFromKey(conversationId)
  return { ownership, label: channelLabelOfOwnership(ownership) }
}
