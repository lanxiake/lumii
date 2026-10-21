/**
 * 渠道「绑定级策略」：在这个渠道里，**每个 peer 该怎么处理**。
 *
 * ---------------------------------------------------------------------------
 * 为什么要单独抽出来
 * ---------------------------------------------------------------------------
 * 本机微信的回复策略（谁能被自动回 / 谁只提醒 / 谁永不处理）此前只活在
 * `~/.lumii/wechat-watch.json` 里——设置页看不见、助手也改不到（实测那次：工作记忆里
 * 记着「已把 Loop 改成 notify」，盘上还是 auto，两边对不上账，见 M1 复盘）。
 * 而「这个人自动回、那个只提醒」并不是本机微信独有：飞书、QQ 一样需要。
 * 所以策略归位到渠道层：**一个渠道一份 policy，按 peer 配，在 设置 → 渠道 里编辑**。
 *
 * ---------------------------------------------------------------------------
 * 为什么是一张「每人一档」的表
 * ---------------------------------------------------------------------------
 * 旧模型是 blacklist + groups[] + defaultMode 三份平行清单，同一个名字可以同时落在
 * 两份里（既在黑名单又在白名单），只能靠「谁先判」的隐式优先级兜着。换成一张表后
 * **黑名单就是 mode='ignore'**，每人一条、先出现的生效——自相矛盾从"靠顺序解释"
 * 变成"根本表示不出来"。
 *
 * 形状放 shared 的理由同 `channel-features.ts`：main（存储/盯梢）、preload（桥）、
 * renderer（表单）三边共用一份定义，不各自手抄。
 */

/**
 * 对某个 peer 的处置方式。
 *
 * - `ignore`  完全不处理（连提醒都不发；黑名单就是它）
 * - `notify`  只提醒我（不打扰对方，也不叫模型）
 * - `draft`   叫醒模型**起草**，草稿落在**那个 peer 的会话**里等我点头
 * - `auto`    直接以我本人身份回（仍有冷却与「发完必报」）
 */
export type PeerReplyMode = 'ignore' | 'notify' | 'draft' | 'auto'

/**
 * **触发条件**：进来的消息够不够格叫醒代聊。
 *
 * 为什么需要：群一天几百条、话痨好友一天几十条，绝大多数跟本人无关。不加闸门时，
 * 只要是名单里的人，每条都要叫一次模型——既贵又吵（回一句「哈哈哈」也值得起一个回合？）。
 *
 * - `all`     每条都处理（不加闸门，默认）
 * - `mention` 只有 @我（**只有群有 @ 这回事**；私聊选了它等于不过滤，见 `triggerAllows`）
 * - `keyword` 正文命中 `keywords` 里任一个词
 * - `mention_or_keyword` 上面两个满足任一（群专用）
 */
export type PeerTrigger = 'all' | 'mention' | 'keyword' | 'mention_or_keyword'

export interface ChannelPeerPolicy {
  /** peer 的稳定 id（本机微信 = 好友 wxid / 群 `xxx@chatroom`） */
  id: string
  /** 展示名（备注名 / 群名）：只用于 UI 与日志 */
  label?: string
  mode: PeerReplyMode
  /** 同一 peer 两次自动动作之间的最小间隔（秒）；缺省 60 */
  cooldownSeconds?: number
  /** 触发条件（缺省 `all`＝每条都处理），见 {@link PeerTrigger} */
  trigger?: PeerTrigger
  /** `trigger` 用了关键字时命中任一即触发（大小写不敏感的子串匹配） */
  keywords?: string[]
}

/**
 * **一个微信账号**的回复策略。
 *
 * 多开时每个号的好友/群、能代回的人、名单外怎么处理都可能不一样：
 * 工作号只提醒、生活号直接代回，是常态而不是边角。所以策略按账号分账，
 * 没单独配过的账号沿用顶层那一份（迁移零成本）。
 */
export interface ChannelAccountPolicy {
  /** 给用户看的备注（如「工作号」），不参与任何匹配 */
  label?: string
  /** 这个号的名单外的人怎么处理 */
  defaultMode: PeerReplyMode
  /** 这个号的每人一档 */
  peers: ChannelPeerPolicy[]
}

export interface ChannelPolicy {
  /**
   * 默认账号（带哪个身份说这些话）。
   * 本机微信 = 登录的 wxid；留空 = 本机当前选中的账号。
   * 多账号的分账在 `accounts` 里；这里只是缺省值。
   */
  accountId?: string
  /** 没列在 `peers` 里的人怎么处理（未单独配置的账号也用它） */
  defaultMode: PeerReplyMode
  /** 每人一档；同一个 peer 只保留第一条（见 `parseChannelPolicy`） */
  peers: ChannelPeerPolicy[]
  /**
   * 多账号：按 wxid 分账。**没出现的账号沿用顶层 `defaultMode` / `peers`**。
   * 键是账号 wxid（大小写不敏感比较，见 `policyForAccount`）。
   */
  accounts?: Record<string, ChannelAccountPolicy>
}

/** 冷却缺省值（秒）。与盯梢的老默认保持一致，避免迁移后行为突变。 */
export const DEFAULT_POLICY_COOLDOWN_S = 60

/**
 * 空策略的默认：**谁都没配过 → 只提醒**。
 *
 * 这个默认是安全侧：不动对方、也不叫模型，用户看得见但没人被代表。
 * 想「只盯名单」的话把 `defaultMode` 设成 `ignore`。
 */
export const DEFAULT_CHANNEL_POLICY: ChannelPolicy = { defaultMode: 'notify', peers: [] }

const MODES: readonly PeerReplyMode[] = ['ignore', 'notify', 'draft', 'auto']

export function isPeerReplyMode(v: unknown): v is PeerReplyMode {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v)
}

/**
 * 「名单外的人怎么处理」**只允许这两档**（2026-10-10 用户定）。
 *
 * 名单外的消息连对方是谁都不知道，让它叫醒模型纯属烧 token——用户原话
 * 「不在代理名单内的微信消息，不需要发给 AGENT」。所以：**想代回谁就把他加进名单**
 * （那是显式选择），名单外最多「只提醒我」（零 token 的确定性读库照样弹通知）。
 *
 * 这里是硬约束而不是界面过滤器：`wechat-watch.json` 手写进来的 `defaultMode: "draft"`
 * 也会被 `parseChannelPolicy` 收敛成 `notify`——只有一道口子等于没有口子。
 */
export const NON_AGENT_MODES: readonly PeerReplyMode[] = ['ignore', 'notify']

const TRIGGERS: readonly PeerTrigger[] = ['all', 'mention', 'keyword', 'mention_or_keyword']

/** 哪些触发条件要配关键字（`keywords` 只对它们有意义）。 */
export const KEYWORD_TRIGGERS: readonly PeerTrigger[] = ['keyword', 'mention_or_keyword']

/** 只有群适用的两档（私聊没有 @ 这回事，界面上不该给用户这个选项）。 */
export const GROUP_ONLY_TRIGGERS: readonly PeerTrigger[] = ['mention', 'mention_or_keyword']

export function isPeerTrigger(v: unknown): v is PeerTrigger {
  return typeof v === 'string' && (TRIGGERS as readonly string[]).includes(v)
}

/** peer 名的比较口径：大小写不敏感（wxid 大小写混写见得多） */
export function isSamePeer(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** 名单外**只能是非-agent 档**（见 `NON_AGENT_MODES`），坏值退回 `notify`。 */
function parseDefaultMode(raw: unknown): PeerReplyMode {
  return isPeerReplyMode(raw) && NON_AGENT_MODES.includes(raw) ? raw : 'notify'
}

/** 容错解析一份「每人一档」名单（顶层与每个账号共用同一套规则）。 */
function parsePeers(raw: unknown): ChannelPeerPolicy[] {
  const out: ChannelPeerPolicy[] = []
  if (!Array.isArray(raw)) return out
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const p = item as Partial<ChannelPeerPolicy>
    const id = typeof p.id === 'string' ? p.id.trim() : ''
    if (!id || !isPeerReplyMode(p.mode)) continue
    if (out.some((x) => isSamePeer(x.id, id))) continue // 同一个 peer 只认先出现的
    const label = typeof p.label === 'string' ? p.label.trim() : ''
    const trigger = isPeerTrigger(p.trigger) ? p.trigger : undefined
    const keywords = Array.isArray(p.keywords)
      ? p.keywords
          .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
          .map((k) => k.trim())
      : []
    out.push({
      id,
      mode: p.mode,
      ...(label ? { label } : {}),
      ...(typeof p.cooldownSeconds === 'number' && p.cooldownSeconds >= 0
        ? { cooldownSeconds: p.cooldownSeconds }
        : {}),
      // 只在真的不是默认行为时落字段：`all` 不写、空关键字不写——配置少一堆噪音
      ...(trigger && trigger !== 'all' ? { trigger } : {}),
      ...(trigger && KEYWORD_TRIGGERS.includes(trigger) && keywords.length ? { keywords } : {}),
    })
  }
  return out
}

function parseAccountPolicy(raw: unknown): ChannelAccountPolicy | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const label = typeof o.label === 'string' ? o.label.trim() : ''
  return {
    ...(label ? { label } : {}),
    defaultMode: parseDefaultMode(o.defaultMode),
    peers: parsePeers(o.peers),
  }
}

/**
 * 容错解析：坏字段逐项退回默认，**绝不抛**。
 *
 * 配置是用户手改的文件，写坏一个字段不该让整条循环停摆（同 `wechat-watch.json` 的口径）。
 */
export function parseChannelPolicy(raw: unknown): ChannelPolicy {
  const out: ChannelPolicy = { ...DEFAULT_CHANNEL_POLICY, peers: [] }
  if (!raw || typeof raw !== 'object') return out
  const o = raw as Record<string, unknown>
  if (typeof o.accountId === 'string' && o.accountId.trim()) out.accountId = o.accountId.trim()
  // 名单外**收敛到非-agent 档**（见 NON_AGENT_MODES）：老配置里的 draft/auto 一律退回 notify
  out.defaultMode = parseDefaultMode(o.defaultMode)
  out.peers = parsePeers(o.peers)
  if (o.accounts && typeof o.accounts === 'object') {
    const accounts: Record<string, ChannelAccountPolicy> = {}
    for (const [rawKey, value] of Object.entries(o.accounts as Record<string, unknown>)) {
      const key = rawKey.trim()
      if (!key || key.startsWith('_')) continue // `_hint` 之类的说明字段
      const parsed = parseAccountPolicy(value)
      if (parsed) accounts[key] = parsed
    }
    if (Object.keys(accounts).length) out.accounts = accounts
  }
  return out
}

function findAccountEntry(
  accounts: Record<string, ChannelAccountPolicy> | undefined,
  accountId: string,
): { key: string; value: ChannelAccountPolicy } | undefined {
  if (!accounts) return undefined
  if (accounts[accountId]) return { key: accountId, value: accounts[accountId] }
  const lower = accountId.toLowerCase()
  for (const [key, value] of Object.entries(accounts)) {
    if (key.toLowerCase() === lower) return { key, value }
  }
  return undefined
}

/** 某个账号实际生效的策略：有分账用自己的，没有就沿用顶层（迁移零成本）。 */
export function policyForAccount(
  policy: ChannelPolicy,
  accountId?: string | null,
): { defaultMode: PeerReplyMode; peers: ChannelPeerPolicy[]; label?: string } {
  const id = (accountId ?? '').trim()
  const hit = id ? findAccountEntry(policy.accounts, id) : undefined
  if (hit) {
    return {
      defaultMode: hit.value.defaultMode,
      peers: hit.value.peers,
      ...(hit.value.label ? { label: hit.value.label } : {}),
    }
  }
  return { defaultMode: policy.defaultMode, peers: policy.peers }
}

/** 某个账号的名单（写回时与 `withPeersForAccount` 配对使用）。 */
export function peersForAccount(
  policy: ChannelPolicy,
  accountId?: string | null,
): ChannelPeerPolicy[] {
  return policyForAccount(policy, accountId).peers
}

/**
 * 把某个账号的名单写回去；`accountId` 为空 = 写顶层。
 *
 * 账号**还没有分账**时新建一份，`defaultMode` 继承顶层——「只改这个号的人」不该
 * 顺手把它对名单外的人的处置也改掉。
 */
export function withPeersForAccount(
  policy: ChannelPolicy,
  accountId: string | null | undefined,
  peers: ChannelPeerPolicy[],
): ChannelPolicy {
  const id = (accountId ?? '').trim()
  if (!id) return { ...policy, peers }
  const hit = findAccountEntry(policy.accounts, id)
  const accounts = { ...(policy.accounts ?? {}) }
  if (hit) delete accounts[hit.key] // 同名不同大小写的键只留一个
  accounts[id] = {
    ...(hit?.value.label ? { label: hit.value.label } : {}),
    defaultMode: hit?.value.defaultMode ?? policy.defaultMode,
    peers,
  }
  return { ...policy, accounts }
}

/** 全部账号的名单并集（去重）：给画像巡检、日志这类「不关心是哪个号」的地方用。 */
export function allPolicyPeers(policy: ChannelPolicy): ChannelPeerPolicy[] {
  const out: ChannelPeerPolicy[] = []
  const seen = new Set<string>()
  for (const p of [
    ...policy.peers,
    ...Object.values(policy.accounts ?? {}).flatMap((a) => a.peers),
  ]) {
    const key = p.id.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
  }
  return out
}

export interface ResolvedPeerPolicy {
  mode: PeerReplyMode
  cooldownSeconds: number
  /** 命中的那一条（`label ?? id`）；走 defaultMode 时为 null —— 日志/提示词用它说明依据 */
  matchedBy: string | null
  /** 触发条件（走 defaultMode 时恒为 `all`：名单外本来就不叫模型，没什么可挡） */
  trigger: PeerTrigger
  keywords: string[]
}

/**
 * 取某个 peer 的策略：先按 **id**（wxid / 群号）匹配，再按 **label**（备注名）匹配，
 * 都没有就走这个账号的 `defaultMode`。
 *
 * `accountId`（多开）：给了就查该账号的分账，没配过沿用顶层——同一句调用在单账号
 * 与多账号下都对。省略时按顶层（旧调用点不必改）。
 *
 * 为什么要按名字兜底：`wechat-watch.json` 时代用户是按显示名手写的（`peers: ["Loop"]`），
 * 首次播种出来的条目 id 就是那个名字。留着这条，迁移不丢策略。
 */
export function resolvePeerPolicy(
  policy: ChannelPolicy,
  peer: { id?: string; label?: string },
  accountId?: string | null,
): ResolvedPeerPolicy {
  const effective = policyForAccount(policy, accountId)
  const keys = [peer.id, peer.label]
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((x) => x.trim().toLowerCase())
  for (const key of keys) {
    const hit = effective.peers.find(
      (p) =>
        p.id.trim().toLowerCase() === key ||
        (p.label ? p.label.trim().toLowerCase() === key : false),
    )
    if (hit) {
      return {
        mode: hit.mode,
        cooldownSeconds: hit.cooldownSeconds ?? DEFAULT_POLICY_COOLDOWN_S,
        matchedBy: hit.label ?? hit.id,
        trigger: hit.trigger ?? 'all',
        keywords: hit.keywords ?? [],
      }
    }
  }
  return {
    mode: effective.defaultMode,
    cooldownSeconds: DEFAULT_POLICY_COOLDOWN_S,
    matchedBy: null,
    trigger: 'all',
    keywords: [],
  }
}
