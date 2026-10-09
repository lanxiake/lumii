/**
 * 微信消息盯梢（谁在「盯着」）
 *
 * ---------------------------------------------------------------------------
 * 为什么要有这条循环
 * ---------------------------------------------------------------------------
 * 在这之前只有两种活法：要么每 N 分钟**叫一次模型**去问「有没有新消息」（token 全花在
 * 「没事发生」上，用户实测 30s 一拍，一天就是几千次白跑），要么根本没人看着。
 * 本模块照 `pet-sensing-tick.ts` 的先例，把「盯」做成**零 token 的确定性读库**：
 *
 *   一拍 = 主进程直接调 MCP 工具 `wechat-local.poll_new`（不经 Agent 回合、不叫模型）
 *        ├─ 没有新消息 → 什么都不做（不通知、不建会话、零 token）
 *        └─ 有新消息   → 推进水位 + 通知用户（系统通知/气泡）
 *
 * 之所以便宜：读取侧已是增量（只解密新增 WAL 帧、只重扫有变化的会话表），
 * 实测 68 个会话一轮 ~35ms；15 秒一拍 ≈ 每秒 0.2% 的时间在干活。
 *
 * ---------------------------------------------------------------------------
 * 护栏（第一版刻意**只通知、不代发**）
 * ---------------------------------------------------------------------------
 * - **绝不自动回复**：以用户身份发消息不可撤回。代回要么用户自己做，要么按
 *   `docs/wechat-mcp-optimization-plan.md` §3.3 的白名单/冷却/熔断方案单独开——那是产品决策，
 *   不在这条循环里默认打开。
 * - 水位落库（`runtime_state`）：重启不重复报；报过的不再重复通知。
 * - **首次运行只看「从现在起」**，不翻历史——否则一开就刷屏。
 * - MCP 失败 = 本轮什么都不做（门闩失败绝不能退化成乱报）。
 *
 * 节拍 15 秒：读取成本可忽略，而「当场感」值得（用户在等对方回话时，15 秒才出现是"它盯着呢"，
 * 几分钟才出现是"它刚才在忙别的"）。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseAdapter } from '@mtbot/agent-runtime'
import { resolveWindowsClientDataRoot } from '../client-data-root'
import {
  isSamePeer,
  resolvePeerPolicy,
  type ChannelPeerPolicy,
  type ChannelPolicy,
  type PeerReplyMode,
} from '../../shared/channel-policy'
import { agentRuntimeLog as log } from './bridge-utils'
import { relayOwnedSection } from './wechat-relay-agent'

export const WECHAT_WATCH_INSTRUCTION = '__wechat_watch__'
/**
 * 数据源（MCP Server 名 + 工具名）：**客户端与 wechat-mcp 解耦**——这里只依赖
 * 「有个 MCP Server 暴露了一个 `poll_new(since_ts)`」这个契约。没配/没连/被禁用时
 * 盯梢安静跳过（见 `runWechatWatch` 的「未连接」分支），客户端不因此不可用。
 */
export const WECHAT_WATCH_MCP_SERVER = 'wechat-local'
/** 导出给开发期回放用：它要认出「哪一次调用是 poll」才好在返回里追加合成消息 */
export const WECHAT_WATCH_MCP_TOOL = 'poll_new'
const WECHAT_WATCH_CRON_ID = 'wechat-watch'
const WECHAT_WATCH_NAME = '微信消息盯梢'
const WECHAT_WATCH_INTERVAL_MS = 15_000

/** 水位键：报过的最新消息 ts（秒）。重启后从这里续读 */
const KV_KEY_LAST_TS = 'wechat_watch_last_ts'
/** 通知里最多列几条（其余折叠成一句） */
const MAX_NOTIFY_ITEMS = 3

/**
 * 这个文件里的 `mode` 用的就是渠道策略的四档（定义与解析在 `shared/channel-policy.ts`）：
 *
 * - `ignore`  完全不处理（连提醒都不发；黑名单就是它）
 * - `notify`  只提醒我（不打扰对方，也不叫模型）
 * - `draft`   叫醒模型**起草**，草稿落在**那个 peer 的会话**里等我点头（我不会不知情地被代表）
 * - `auto`    直接以我本人身份回（白名单专用：仍有冷却与「发完必报」）
 */
export type WatchMode = PeerReplyMode

/**
 * 一个分组的策略。**自 2026-10-08 起只是历史形态**：
 *
 * 策略的真源已经搬到渠道层（`~/.lumii/channel/channel-policies.json`，设置页 → 渠道里改），
 * 这里的 `blacklist` / `groups` 只在**首次播种**时读一次（`policyFromWatchConfig`），
 * 之后改这个文件里的这两项不再影响行为。`enabled` / `notify` / `instructionsFile` 仍是
 * 本文件的活跃字段（它们是"这条循环怎么跑"，不是"谁可以被代表"）。
 */
export interface WechatWatchGroup {
  /** 分组名（只用于日志里说明这一组是怎么来的） */
  name: string
  mode: WatchMode
  /** 组内会话（显示名或 wxid/群号，大小写不敏感） */
  peers: string[]
  /** 同一会话两次自动动作之间的最小间隔（秒）；默认 60 */
  cooldownSeconds?: number
}

export interface WechatWatchConfig {
  /** 总开关（任务页暂停也能停） */
  enabled: boolean
  /** 是否发系统通知 */
  notify: boolean
  /** 不在 peers 表里的人怎么处理（**仅播种用**；真源在渠道策略里） */
  defaultMode: WatchMode
  /** 永不处理（连提醒都不发）——**仅播种用**（播种时落成 mode='ignore' 的条目） */
  blacklist: string[]
  /** 分组策略（先匹配到的组生效）——**仅播种用** */
  groups: WechatWatchGroup[]
  /**
   * 用户手写的手册文件（workspace 相对路径或绝对路径）。
   *
   * **兜底用**（M3，2026-10-09）：护栏与工作流的唯一真源是程序分区 `relayOwnedSection()`，
   * 平时住在「灵栖代聊」的 systemPrompt 里；只有这条 Agent 不在（删了/禁用了）时才回落成
   * 每轮注入，那时这份手册作为**补充口径**跟着走。
   *
   * 为什么要注入而不是让模型自己去读：手册里每一条都是「不许做什么」——这种约束交给模型
   * 「记得先去读」是赌运气（attended 时它会读，忙着回消息时它可能直接开口）。注入是硬约束。
   */
  instructionsFile?: string
}

export const DEFAULT_WECHAT_WATCH_CONFIG: WechatWatchConfig = {
  enabled: true,
  notify: true,
  defaultMode: 'notify',
  // 早先默认把 `filehelper` 当黑名单（自聊也被当"自己发的"过滤）。2026-10-09 起**不管它**：
  // 用户给自己（文件传输助手）发的消息要当成与飞书/企微一样的**入站渠道**（见 isSelfChatPeer）。
  blacklist: [],
  groups: [],
}

/** 自聊会话标识：文件传输助手（用户给自己发消息的天然通道）。 */
export const FILE_HELPER_TALKER = 'filehelper'
/** 自聊 peer 的默认冷却（秒）：要盖过「一拍 15s + 发送延迟」，免得助手刚回的那条又被当成新消息。 */
export const SELF_PEER_COOLDOWN_S = 20

/**
 * 是不是「用户给自己发消息」的自聊会话：文件传输助手，或本人 wxid。
 *
 * 为什么单列：这些会话里 `from_me` **恒为真**（发的人就是本人），但语义是「用户发给助手」，
 * 必须当**入站**处理——否则 `!from_me` 那条通用过滤会把它们全丢掉（这正是"手机给自己发消息
 * 被无视"的来路）。普通会话仍严格 `!from_me`：那是**防自回环**（助手自己发的话不再触发）。
 */
export function isSelfChatPeer(talker: string | undefined, selfWxids: readonly string[] = []): boolean {
  const t = (talker ?? '').trim().toLowerCase()
  if (!t) return false
  if (t === FILE_HELPER_TALKER) return true
  return selfWxids.some((w) => !!w && w.trim().toLowerCase() === t)
}

/**
 * 确保自聊 peer 在名单里且**可回**（`auto`）：用户显式要求「把自己的微信号默认加入白名单」。
 *
 * `flipIgnore`：只在该 peer 从未被处理过时（一次性迁移）把旧默认的 `ignore` 纠成 `auto`；
 * 迁完之后只补缺、不覆盖——用户在设置页把 filehelper 改回 `ignore`/`notify` 是用户的选择。
 * 返回新策略与是否改动（改动才落盘）。
 */
export function withSelfPeers(
  policy: ChannelPolicy,
  selfWxids: readonly string[],
  opts: { flipIgnore?: boolean } = {},
): { policy: ChannelPolicy; changed: boolean } {
  const ids = [FILE_HELPER_TALKER, ...selfWxids.filter((w) => !!w && w.trim())]
  const peers = [...policy.peers]
  let changed = false
  for (const id of ids) {
    const idx = peers.findIndex((p) => isSamePeer(p.id, id))
    if (idx === -1) {
      peers.push({
        id,
        mode: 'auto',
        label: id === FILE_HELPER_TALKER ? '文件传输助手' : id,
        cooldownSeconds: SELF_PEER_COOLDOWN_S,
      })
      changed = true
    } else if (opts.flipIgnore && peers[idx].mode === 'ignore') {
      peers[idx] = {
        ...peers[idx],
        mode: 'auto',
        cooldownSeconds: peers[idx].cooldownSeconds ?? SELF_PEER_COOLDOWN_S,
      }
      changed = true
    }
  }
  return changed ? { policy: { ...policy, peers }, changed } : { policy, changed }
}

// 自聊回环护栏：助手刚发出去的话，下一拍会以 `from_me` 出现在同一会话里——不记住的话会被
// 当成"用户又发了一条"再触发一次。记 peer→[文本, 时刻]，TTL 内按**文本**跳过。
const SELF_SEND_TTL_MS = 5 * 60_000
const recentSelfSends = new Map<string, { text: string; at: number }[]>()

export function rememberSelfSends(peer: string, texts: readonly string[], nowMs: number): void {
  if (!peer || !texts.length) return
  const fresh = (recentSelfSends.get(peer) ?? []).filter((x) => nowMs - x.at <= SELF_SEND_TTL_MS)
  for (const t of texts) if (t && t.trim()) fresh.push({ text: t, at: nowMs })
  recentSelfSends.set(peer, fresh)
}

function wasSelfSent(peer: string, text: string | undefined, nowMs: number): boolean {
  const arr = recentSelfSends.get(peer)
  if (!arr || !text) return false
  return arr.some((x) => nowMs - x.at <= SELF_SEND_TTL_MS && x.text === text)
}

/** 配置文件路径（用户可手改；`LUMII_CLIENT_DATA_DIR` 生效，便于隔离测试） */
export function wechatWatchConfigPath(): string {
  return path.join(resolveWindowsClientDataRoot(), 'wechat-watch.json')
}

/**
 * 首次运行时把默认配置写到盘上（存在就不动）。
 *
 * 为什么写：不写的话用户根本不知道有哪些开关（`watch` 白名单尤其要紧——
 * 不窄化的话每个群消息都会弹通知）。文件里带一个 `_hint` 字段说明用法，
 * 解析器会忽略它（见 `parseWechatWatchConfig`）。
 */
export function ensureWechatWatchConfigFile(configPath = wechatWatchConfigPath()): void {
  try {
    if (fs.existsSync(configPath)) return
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    const content = {
      _hint:
        '微信消息盯梢：enabled=总开关；notify=是否弹系统通知；instructionsFile=手册文件（workspace 相对路径）。' +
        '⚠️ 「谁可以被怎么回」已搬到渠道策略（~/.lumii/channel/channel-policies.json，之后在设置页的渠道卡片里改）；' +
        '这里的 defaultMode / blacklist / groups 只在**首次**把老策略搬过去时读一次，之后改它们不再生效。' +
        'mode 含义：ignore=完全不处理；notify=只提醒我；draft=让助手起草、我点头才发；auto=直接替我回（建议只给信得过的人，cooldownSeconds 默认 60）。改完存盘即生效，不用重启。',
      ...DEFAULT_WECHAT_WATCH_CONFIG,
    }
    fs.writeFileSync(configPath, JSON.stringify(content, null, 2) + '\n', 'utf-8')
    log.info(`[wechat-watch] 已写出默认配置：${configPath}`)
  } catch (err) {
    log.warn('[wechat-watch] 写默认配置失败（继续用内置默认值）:', err)
  }
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
}

const MODES: readonly WatchMode[] = ['ignore', 'notify', 'draft', 'auto']

function asMode(v: unknown, fallback: WatchMode): WatchMode {
  return typeof v === 'string' && (MODES as readonly string[]).includes(v)
    ? (v as WatchMode)
    : fallback
}

/**
 * 读配置：缺文件/坏 JSON/字段类型不对 **一律退回默认值**，绝不抛——
 * 盯梢是后台循环，不能因为用户手改坏一行就把整拍炸掉。
 *
 * 兼容 v1：老的 `watch: [...]` 等价于「一个 notify 分组 + defaultMode=ignore」，
 * 老的 `ignore: [...]` 就是 blacklist —— 老文件不用改也能继续用。
 */
export function parseWechatWatchConfig(raw: unknown): WechatWatchConfig {
  const out: WechatWatchConfig = { ...DEFAULT_WECHAT_WATCH_CONFIG, groups: [] }
  if (!raw || typeof raw !== 'object') return out
  const o = raw as Record<string, unknown>
  if (typeof o.enabled === 'boolean') out.enabled = o.enabled
  if (typeof o.notify === 'boolean') out.notify = o.notify
  out.defaultMode = asMode(o.defaultMode, out.defaultMode)
  const blacklist = asStringArray(o.blacklist)
  if (blacklist) out.blacklist = blacklist
  const groups: WechatWatchGroup[] = []
  if (Array.isArray(o.groups)) {
    for (const g of o.groups) {
      if (!g || typeof g !== 'object') continue
      const gg = g as Record<string, unknown>
      const peers = asStringArray(gg.peers)
      if (!peers || peers.length === 0) continue
      const cd = Number(gg.cooldownSeconds)
      groups.push({
        name: typeof gg.name === 'string' && gg.name.trim() ? gg.name.trim() : '未命名分组',
        mode: asMode(gg.mode, 'notify'),
        peers,
        cooldownSeconds: Number.isFinite(cd) && cd >= 0 ? cd : undefined,
      })
    }
  }
  out.groups = groups
  if (typeof o.instructionsFile === 'string' && o.instructionsFile.trim()) {
    out.instructionsFile = o.instructionsFile.trim()
  }
  // ── v1 兼容 ──
  if (out.groups.length === 0 && asStringArray(o.watch)?.length) {
    out.groups = [{ name: '白名单', mode: 'notify', peers: asStringArray(o.watch)! }]
    if (o.defaultMode === undefined) out.defaultMode = 'ignore'
  }
  const legacyIgnore = asStringArray(o.ignore)
  if (legacyIgnore && !blacklist) out.blacklist = legacyIgnore
  return out
}

/**
 * 旧配置 → 渠道策略（**迁移用，只播种一次**；之后真源在渠道策略里）。
 *
 * 映射是同义的：黑名单 → `mode:'ignore'` 的条目，分组 → 组内每个人各一条（带上组里的冷却），
 * 组外走 `defaultMode`。
 *
 * **黑名单条目排在最前**：旧模型里黑名单优先于分组（同一个名字两边都写时），新模型是
 * 「先出现的生效」——保序即保语义。
 */
export function policyFromWatchConfig(cfg: WechatWatchConfig): ChannelPolicy {
  const peers: ChannelPeerPolicy[] = [
    ...cfg.blacklist
      .filter((id) => id.trim())
      .map((id) => ({ id: id.trim(), mode: 'ignore' as const })),
    ...cfg.groups.flatMap((g) =>
      g.peers
        .filter((p) => p.trim())
        .map((p) => ({
          id: p.trim(),
          mode: g.mode,
          ...(g.cooldownSeconds !== undefined ? { cooldownSeconds: g.cooldownSeconds } : {}),
        })),
    ),
  ]
  return { defaultMode: cfg.defaultMode, peers }
}

/**
 * 把人名条目换成真 wxid（自愈绑定）。
 *
 * 从 `wechat-watch.json` 迁移过来的老条目 id 就是**备注名**（`peers: ["Loop"]`）。
 * 名字只说明"他现在叫什么"，不说明"他是谁"：对方一改名就失联，而且渠道出站的名单闸门
 * 只认 id（`to ∈ snapshot.peers`），拿 wxid 去发会被当成"名单外的人"拒掉——同一份策略
 * 两个口径。所以在第一次收到他本人的消息时（此刻才知道 talker↔名字的对应）换成真 talker，
 * 名字挪到 label 里，一次改完。
 *
 * 返回要落盘的新策略；不需要改（已绑好 / 找不到条目）时返回 `null`。
 */
export function healPeerBinding(
  policy: ChannelPolicy,
  peer: { id?: string; label?: string },
): ChannelPolicy | null {
  const id = peer.id?.trim()
  const label = peer.label?.trim()
  if (!id || !label) return null
  if (policy.peers.some((p) => isSamePeer(p.id, id))) return null // 已经对得上，别动
  const idx = policy.peers.findIndex(
    (p) => isSamePeer(p.id, label) || (p.label ? isSamePeer(p.label, label) : false),
  )
  if (idx < 0) return null
  const peers = [...policy.peers]
  peers[idx] = { ...peers[idx], id, label }
  return { ...policy, peers }
}

export function loadWechatWatchConfig(configPath = wechatWatchConfigPath()): WechatWatchConfig {
  try {
    if (!fs.existsSync(configPath)) return { ...DEFAULT_WECHAT_WATCH_CONFIG }
    return parseWechatWatchConfig(JSON.parse(fs.readFileSync(configPath, 'utf-8')))
  } catch (err) {
    log.warn(`[wechat-watch] 配置读取失败，按默认值继续（${configPath}）：`, err)
    return { ...DEFAULT_WECHAT_WATCH_CONFIG }
  }
}

/** 一条新消息（`poll_new` 返回的最小面） */
export interface WechatMessage {
  ts: number
  name?: string
  talker?: string
  text?: string
  from_me?: boolean
  /** 真实发送者的显示名（`msg_dict` 给的；私聊即对方本人，群里才是说话的人） */
  sender?: string
}

/** `poll_new` 的返回（只声明这条循环用到的字段） */
interface PollPayload {
  messages?: WechatMessage[]
  next_since_ts?: number
}

/**
 * 挑出「要处理」的消息：**别人发的**，外加**自聊会话里自己发的**（用户给自己发消息=发给助手）。
 * `ignore` 档一律剔除（连提醒都不给）。
 *
 * 自聊（文件传输助手 / 本人 wxid）的 `from_me=true` 是常态，不能按"自己发的不必提醒自己"过滤掉
 * ——那是**入站**。普通会话仍严格 `!from_me`：助手自己的回复（from_me）不再触发，防自回环。
 */
export function selectNewMessages(
  messages: readonly WechatMessage[],
  policy: ChannelPolicy,
  selfWxids: readonly string[] = [],
): WechatMessage[] {
  return messages.filter((m) => {
    if (m.from_me && !isSelfChatPeer(m.talker, selfWxids)) return false
    return resolvePeerPolicy(policy, { id: m.talker, label: m.name }).mode !== 'ignore'
  })
}

const fmtText = (s?: string) => (s || '').replace(/\s+/g, ' ').slice(0, 300)
const fmtWhen = (ts: number) => new Date(ts * 1000).toLocaleString('zh-CN')

/** 手册文件（workspace 相对或绝对）→ 全文；读不到给空串（不阻塞，但会记一条 warn）。
 *  只在回落路径上被调用（代聊 Agent 不在时）——它在的时候手册不参与提示词。 */
export const MAX_INSTRUCTIONS_CHARS = 20_000

export function resolveWorkspacePath(p: string): string {
  return path.isAbsolute(p) ? p : path.join(resolveWindowsClientDataRoot(), 'workspace', p)
}

export function loadInstructions(file: string | undefined): string {
  if (!file) return ''
  const full = resolveWorkspacePath(file)
  try {
    if (!fs.existsSync(full)) {
      log.warn(`[wechat-watch] 手册文件不存在：${full}（本轮只带程序分区护栏，不带用户的补充口径）`)
      return ''
    }
    const text = fs.readFileSync(full, 'utf-8').trim()
    return text.length > MAX_INSTRUCTIONS_CHARS ? text.slice(0, MAX_INSTRUCTIONS_CHARS) : text
  } catch (err) {
    log.warn(`[wechat-watch] 手册读取失败：${full}`, err)
    return ''
  }
}

function instructionsBlock(runbook: string, file: string | undefined): string[] {
  // 护栏分档与工作流是**程序分区**，兜底路径也必须带上：它现在是护栏的唯一真源
  // （代聊 Agent 在的时候这段住在它的 systemPrompt 里，见 wechat-relay-agent.ts）。
  // 用户手册只在 Agent 不在时作为**补充口径**跟着走。
  return [
    relayOwnedSection(),
    ...(runbook
      ? [`【用户手写的手册（${file} 全文，补充口径；与上面的分档冲突时以分档为准）】`, runbook, '【手册结束】', '']
      : []),
  ]
}

/** 起草模式的提示词：本次触发 → 只起草不许发 */
export function buildDraftPrompt(
  msg: WechatMessage,
  runbook = '',
  instructionsFile?: string,
): string {
  const who = msg.name || msg.talker || '对方'
  return [
    ...instructionsBlock(runbook, instructionsFile),
    '【本次触发】监控回路把消息取好了，**不要再轮询**；按上面的护栏与工作流处置这一批即可：',
    `微信「${who}」刚给我发来（${fmtWhen(msg.ts)}）：`,
    `「${fmtText(msg.text)}」`,
    '（这个人的策略是：起草给我确认。）',
    '',
    '请：',
    `1. 用 wechat-local 的 read_history 看我和「${who}」最近的对话（talker=${msg.talker}）；`,
    '2. 判档后写一条**以我本人身份**发出的回复草稿（放行/软回那两档）；命中硬停的，就写转人工的措辞。',
    '',
    '⚠️ 这一档**只起草、不要发送**（不要调用 channel_send、也不要碰 MCP 的发送工具）——',
    '把草稿写给我看，我回「发」你才发。',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * 自动回模式的提示词：本次触发 → 判档 → 三个出口。
 *
 * **不复述护栏的映射**（哪类消息属于哪档只在程序分区里写一次）。2026-10-09 之前这里
 * 自带过一份清单，写的是 v1 的旧口径（要承诺/质疑身份 → **一条都不发**），与 v2 分档
 * （那两档是**软回**：发一句不含承诺的话再转人工）**正好相反**——而这段是用户消息、
 * 位置最靠后最显眼，于是"该软回的事变成沉默"的老毛病在这儿复发。
 *
 * 收尾也不再要求模型「等 20~30 秒做落地校验、写 transcript、更新 state.json」：
 * - 落地校验回路自己用读库实测做（`detectSentTo`），模型的说法本来就只是文本；
 * - transcript.md / state.json 是死掉的 30s cron 的产物，与盯梢回路无关。
 * 实测代价：那条指令让每个回合多烧 ~60 秒（模型真的 `sleep 25`），而 15 秒一拍的回路
 * 在此期间被「已在运行中，跳过」，新消息至少晚一分钟才被处理。
 */
export function buildAutoPrompt(
  msg: WechatMessage,
  runbook = '',
  instructionsFile?: string,
): string {
  const who = msg.name || msg.talker || '对方'
  return [
    ...instructionsBlock(runbook, instructionsFile),
    '【本次触发】监控回路把消息取好了，**不要再轮询、也不要去查水位**：',
    `微信「${who}」刚给我发来（${fmtWhen(msg.ts)}）：`,
    `「${fmtText(msg.text)}」`,
    '（这个人的策略是：**允许按护栏直接替我回**。）',
    '',
    '先判档，再走对应的出口：',
    `- **放行** → \`channel_send\`（channel="pcwechat", to="${msg.talker}", text=你要说的话）直接回；`,
    '  短、口语，像我本人。这是**唯一允许的发送路径**（渠道层会再挡一道名单并留发送记录，绕开它自己发绝对不要）。',
    '- **软回** → 先把那一句「不含任何承诺」的话发出去，再转人工。',
    '- **硬停** → 微信侧一条都不发，只转人工。',
    '',
    '发送成不成**不用你自己去验**：回路的读库实测会判定这一轮到底发出去没有；',
    '发不出去的那条系统已经排队，手一回来会自己补发。把该说的话说完就**到此为止**。',
  ]
    .filter(Boolean)
    .join('\n')
}

/** 组装通知正文：`名字：内容`，最多列 MAX_NOTIFY_ITEMS 条 */
export function formatWechatNotice(messages: readonly WechatMessage[]): string {
  const lines = messages.slice(0, MAX_NOTIFY_ITEMS).map((m) => {
    const who = m.name || m.talker || '（未知会话）'
    const text = (m.text || '').replace(/\s+/g, ' ').slice(0, 80)
    return `${who}：${text}`
  })
  const rest = messages.length - lines.length
  if (rest > 0) lines.push(`…还有 ${rest} 条`)
  return lines.join('\n')
}

/**
 * 这一轮之后，我名下有没有真发出去的消息？（**读库实测**，不是看回合怎么说）
 *
 * 两个地方都用它，理由相同——回合的说法只是文本，库才是事实：
 * - auto：回合说「已发出」也可能是没发成/它改主意了 → 摘要不能写成「已代回」；
 * - draft：提示词写了「只起草不许发」，但那是约定 → 真发了要标 ⚠️。
 */
async function detectSentTo(
  deps: WechatWatchDeps,
  msg: WechatMessage,
  since: number,
): Promise<{ sent: boolean; texts: string[] }> {
  try {
    const text = await deps.callMcpTool(WECHAT_WATCH_MCP_SERVER, WECHAT_WATCH_MCP_TOOL, {
      since_ts: since,
    })
    const payload = JSON.parse(text) as PollPayload
    const mine = (payload.messages ?? []).filter(
      (m) => m.from_me && (m.talker === msg.talker || (!!m.name && m.name === msg.name)),
    )
    return { sent: mine.length > 0, texts: mine.map((m) => m.text ?? '') }
  } catch {
    return { sent: false, texts: [] }
  }
}

function readLastTs(db: DatabaseAdapter): number | null {
  try {
    const row = db
      .prepare<{ value: string }>(`SELECT value FROM runtime_state WHERE key = ?`)
      .get(KV_KEY_LAST_TS) as { value: string } | undefined
    if (!row) return null
    const n = Number(row.value)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

function writeLastTs(db: DatabaseAdapter, ts: number): void {
  try {
    db.prepare(`INSERT OR REPLACE INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)`).run(
      KV_KEY_LAST_TS,
      String(ts),
      new Date().toISOString(),
    )
  } catch (err) {
    log.error('[wechat-watch] 水位写入失败:', err)
  }
}

/**
 * 只留最近 MAX_KEPT_RUNS 条本任务的执行记录。
 *
 * 为什么必须自己裁：cron 的执行记录只在「删任务」时清（`cron-scheduler.ts` 的
 * `deleteLocalCronJob`），没有全局保留期。这条循环 15 秒一拍、绝大多数拍是「无新消息」，
 * 一天就是 ~5700 行——不裁的话运行时库一年要涨几百 MB，全是空转记录。
 */
const MAX_KEPT_RUNS = 500

function pruneOwnRuns(db: DatabaseAdapter): void {
  try {
    db.prepare(
      `DELETE FROM local_cron_runs WHERE job_id = ? AND id NOT IN (
         SELECT id FROM local_cron_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?
       )`,
    ).run(WECHAT_WATCH_CRON_ID, WECHAT_WATCH_CRON_ID, MAX_KEPT_RUNS)
  } catch (err) {
    log.warn('[wechat-watch] 执行记录裁剪失败:', err)
  }
}

export interface WechatWatchDeps {
  getDb: () => DatabaseAdapter
  /** 直接调 MCP 工具（主进程内、不经 Agent 回合），见 `McpManager.callTool` */
  callMcpTool: (server: string, tool: string, args: Record<string, unknown>) => Promise<string>
  /** 系统通知（第三个参数是会话 id，点击可跳到那个好友的会话） */
  showNotification?: (title: string, body: string, convId?: string) => void
  /**
   * 驱动一次 Agent 回合（bridge 注入）。
   *
   * 没有它时 draft/auto 一律降级为「通知」——这条循环的核心是**不依赖**某个具体接线，
   * 缺哪个部件就退到哪一档，绝不半途出错。
   */
  driveTurn?: (prompt: string, meta: WatchTurnMeta) => Promise<string>
  /**
   * 绑定的回复策略（bridge 注入：读渠道策略存储，设置页里改的就是它）。
   *
   * 不给就按旧 `wechat-watch.json` 推导——测试与「渠道层还没接上」时行为与从前一致。
   */
  getPolicy?: () => ChannelPolicy
  /** 落盘策略（bridge 注入：写渠道策略存储）。自愈绑定用它把人名条目换成真 wxid */
  setPolicy?: (policy: ChannelPolicy) => void
  /**
   * 本机微信的**本人 wxid 列表**（bridge 注入：从 MCP `locate_db`/`check_env` 拿，带缓存）。
   *
   * 用来识别「自聊会话」（文件传输助手 + 本人 wxid）：那些会话里 `from_me` 恒真，但要当**入站**
   * 处理。拿不到就给空数组，此时只认 `filehelper`（仍能覆盖最常见的"手机给自己发"）。
   */
  getSelfWxids?: () => Promise<readonly string[]>
  /**
   * 代聊 Agent（bridge 注入：`getAgentRecord('wechat-relay')`，见 `wechat-relay-agent.ts`）。
   *
   * **给了它**就说明护栏与工作流已经住在这个 Agent 的 systemPrompt 里，提示词只递「本次触发」；
   * **没给**（老机器没播种 / 用户在设置页把它删了·禁用了）就回落：把程序分区 `relayOwnedSection()`
   * 注入本轮提示词（再带上用户手册当补充口径）——护栏绝不能因为少了一个 Agent 就静默消失。
   */
  getRelayAgent?: () => { id: string; systemPrompt?: string } | undefined
  /** 覆盖配置路径（测试用） */
  configPath?: string
  /** 直接给定配置（测试用；给了就不读文件） */
  config?: WechatWatchConfig
  /** 时间源（测试用） */
  nowMs?: () => number
}

/**
 * 驱动回合时要带上「这条会话是谁的」。
 *
 * 会话**按 peer 分**（`pcwechat:<talker>`，见 `watchConversationIdFor`）：一个好友一条线，
 * 历史按人聚合、点通知直达那个人。此前是所有好友共用一条 `wechat:watch` 单例——
 * 那是为了满足「建实例必须给 conversationId」而手搓的宿主，不是功能必需；
 * 混线会让用户在一个没有对方的线程里看所有人的代回记录。
 */
export interface WatchTurnMeta {
  /** 冷却表的会话键（talker 优先，退化到显示名） */
  peer: string
  /** 会话 id（`pcwechat:<peer>`） */
  convId: string
  /** 会话标题（`本机微信 · <名字>`） */
  title: string
  mode: WatchMode
  /**
   * 触发这一轮的那批消息（本拍同一会话合并而来的全部）。
   *
   * 要整批带上：桥接侧得把它们**落进会话历史**（见 `formatIncomingForHistory`），
   * 否则用户点进代聊会话只看得到助手一边的回复，不知道对方说了什么。
   */
  incoming: readonly WechatMessage[]
}

/**
 * 「对方说了什么」在代聊会话历史里的显示形态。
 *
 * 群消息前面补发送者：群里 `talker` 是群号、`name` 是群名（`wechat_core.msg_dict`），
 * 不补就不知道是谁说的。私聊不补——会话标题里就是这个人。
 * 非文本（图片/语音/卡片）在 MCP 侧已被换成 `[非文本消息]`，只有空正文才走兜底。
 */
export function formatIncomingForHistory(m: WechatMessage): string {
  const body = (m.text ?? '').trim() || '（非文本消息）'
  return m.sender && m.talker?.endsWith('@chatroom') ? `${m.sender}：${body}` : body
}

/** 注入提示词的每份画像上限（字符）。画像卡本该几百字，超了是该重蒸馏，不是该塞更多。 */
export const WECHAT_PROFILE_MAX_CHARS = 1500

/** 一份画像：`label` 是给模型看的标题，`content` 是 `wechat_profile_get` 返回的正文。 */
export interface WechatProfileBlock {
  label: string
  content: string
  /**
   * 没有这份画像（或已过期）时，在提示词里写下这句**事实**。
   *
   * 只写事实、不在这里写步骤：步骤是 Agent 的预设工作流（`wechat-relay-agent.ts`
   * 的 `relayWorkflowSection`），两处各写一份就会漂移。没给这句时缺画像就静默跳过。
   */
  whenMissing?: string
}

/**
 * 把蒸馏出的画像拼成**代聊提示词的前缀**（每轮注入）。没有任何一份可用时返回 `''`。
 *
 * 落盘文件的正文由 LLM 写成（`wechat_profile_save`），第一行是
 * `<!-- wechat-distill scope=… updated=… -->` 这类元数据——那行是给机器看的，注入前剥掉，
 * 否则模型会把它当成内容的一部分。
 *
 * 为什么要**注入**而不是让模型自己调 `wechat_profile_get`：取不取、取到几条全靠模型自觉，
 * 那就是"有时候准有时候不准"；代聊要的是每轮都带着同一份前提（用户 2026-10-08 定的）。
 * 代价记在这里：画像来自聊天内容，拼进提示词等于把那部分内容送进模型上下文，
 * 所以**有长度上限**；文件全在本机白盒目录，可编辑、可一键删。
 */
export function formatWechatProfiles(blocks: readonly WechatProfileBlock[]): string {
  const parts: string[] = []
  for (const b of blocks) {
    const body = b.content
      .split('\n')
      .filter((l) => !l.trim().startsWith('<!--'))
      .join('\n')
      .trim()
    if (body) parts.push(`## ${b.label}\n${body.slice(0, WECHAT_PROFILE_MAX_CHARS)}`)
    else if (b.whenMissing) parts.push(`## ${b.label}\n${b.whenMissing}`)
  }
  if (!parts.length) return ''
  return `以下是本机微信**本地蒸馏**出的画像，用作口吻与背景的参考；与本次消息冲突时**以消息为准**：
（来源是本机 \`~/.lumii/wechat-distill/\`，用户可编辑或删除）

${parts.join('\n\n')}`
}

/**
 * 本机微信会话的 id / 标题（**唯一构造处**）。
 *
 * 归属 `pcwechat` = 「助手在这台电脑上以用户身份跟好友说话」，与 `weixin`
 * （用户在微信里找 Lumii）方向相反，所以在侧栏是独立分组（渠道 tab → 本机微信）。
 * 前缀同时被 `channel-identity.ts` 的归属表用于落库 `conversations.channel_type`。
 */
export const PCWECHAT_CHANNEL = 'pcwechat'
export const PCWECHAT_CONV_PREFIX = `${PCWECHAT_CHANNEL}:`

export function watchConversationIdFor(peer: string): string {
  return `${PCWECHAT_CONV_PREFIX}${peer}`
}

export function watchConversationTitleFor(name: string | undefined, peer: string): string {
  // 不能写 `(name || peer).trim()`：`'   '` 是真值，会 trim 成空 → 标题只剩「本机微信 · 」
  const display = (name ?? '').trim() || peer.trim() || '微信好友'
  return `本机微信 · ${display}`
}

/** 画像巡检的间隔：空闲拍上给名单里**还没有画像**的人补一张（一轮一个，不是批量刷） */
export const PROFILE_SWEEP_INTERVAL_MS = 30 * 60_000
const KV_KEY_PROFILE_SWEEP = 'wechat_watch_profile_sweep'

/**
 * `wechat_profile_get`（不给 scope）返回的 `files`（相对路径）→ 已有的 scope 列表。
 *
 * `contacts/<scope>.md` 是某个联系人的画像、`self.md` 是用户自己的（scope=self，
 * 不是"某人"）。只认这两种形状，认不出的文件忽略——枚举目录是别人的自由。
 */
export function profileScopesFromFiles(files: unknown): string[] {
  if (!Array.isArray(files)) return []
  const out: string[] = []
  for (const f of files) {
    if (typeof f !== 'string') continue
    const m = /^contacts[/\\](.+)\.md$/.exec(f.trim())
    if (m) out.push(m[1]!)
  }
  return out
}

/**
 * 本拍该给谁补画像：名单里（非 ignore）**第一**个还没有画像的。
 *
 * 为什么只取一个：「补齐所有人的画像」不是一次突发任务——每轮一个，模型每轮只付一次
 * 蒸馏的代价，也不会一开机就把端点打满（见 shared-model-endpoint-concurrency 那笔账）。
 */
export function pickProfileSweepTarget(
  peers: readonly { id: string; label?: string; mode: WatchMode }[],
  knownScopes: readonly string[],
): { id: string; label?: string } | undefined {
  const known = new Set(knownScopes)
  for (const p of peers) {
    if (!p.id || p.mode === 'ignore') continue
    // 名单里的人名条目（还没自愈成 wxid）也会被当成 talker 试一次；对不上就在下一拍换成
    // 真正的条目——巡检是**机会性**的，不必为它加一套解析
    if (!known.has(p.id) && !(p.label && known.has(p.label))) return { id: p.id, label: p.label }
  }
  return undefined
}

/**
 * 让代聊给某人**建画像**的本轮指令（后台巡检用）。
 *
 * 三条都不能省：① 指明只做一件事；② 步骤指向 Agent 自己那份工作流（不在这里复述，
 * 免得两处口径漂移）；③ **明确不许发微信**——巡检轮没有"新消息要回"，
 * 但代聊的 systemPrompt 是鼓励回话的，不写死这一条就可能给人家凭空发一句。
 */
export function buildProfileSweepPrompt(name: string | undefined, peer: string): string {
  return [
    `【画像巡检】本轮**只做一件事**：给「${name || peer}」（talker=${peer}）建一份画像，`,
    '放进本机 `~/.lumii/wechat-distill/`。',
    '',
    '步骤按你 systemPrompt 里【Lumii 预设的工作流】第 2 条走：`wechat_digest`（talker 传上面那个）',
    '拿统计与样本 → 写成 ≤250 字的画像卡 → `wechat_profile_save` → `wechat_distill_state(action="set")` 记水位。',
    '',
    '⚠️ 这是**后台巡检**：本轮**不要给微信里的任何人发消息**（没有新消息要回，也不要用',
    '`channel_send` 去打招呼）。做完用 task_complete 汇报一句「已建画像」或「样本不足」。',
  ].join('\n')
}


/** 只在这拍恰好涉及一个会话时给出跳转目标（涉及多个就没法替用户挑一个） */
function soleConvId(ids: ReadonlySet<string>): string | undefined {
  return ids.size === 1 ? [...ids][0] : undefined
}

const KV_KEY_COOLDOWN = 'wechat_watch_cooldown'

function readCooldowns(db: DatabaseAdapter): Record<string, number> {
  try {
    const row = db
      .prepare<{ value: string }>(`SELECT value FROM runtime_state WHERE key = ?`)
      .get(KV_KEY_COOLDOWN) as { value: string } | undefined
    if (!row) return {}
    const o = JSON.parse(row.value) as unknown
    return o && typeof o === 'object' ? (o as Record<string, number>) : {}
  } catch {
    return {}
  }
}

function writeCooldowns(db: DatabaseAdapter, map: Record<string, number>): void {
  try {
    db.prepare(`INSERT OR REPLACE INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)`).run(
      KV_KEY_COOLDOWN,
      JSON.stringify(map),
      new Date().toISOString(),
    )
  } catch (err) {
    log.warn('[wechat-watch] 冷却表写入失败:', err)
  }
}

function readKvNumber(db: DatabaseAdapter, key: string): number {
  try {
    const row = db
      .prepare<{ value: string }>(`SELECT value FROM runtime_state WHERE key = ?`)
      .get(key) as { value: string } | undefined
    const n = Number(row?.value)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

function writeKvNumber(db: DatabaseAdapter, key: string, value: number): void {
  try {
    db.prepare(`INSERT OR REPLACE INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)`).run(
      key,
      String(value),
      new Date().toISOString(),
    )
  } catch (err) {
    log.warn(`[wechat-watch] ${key} 写入失败:`, err)
  }
}

/**
 * 待补发的出站（**发送门暂时够不着**：微信没运行 / 主窗口收进托盘 / 会话切不过去）。
 *
 * 为什么要有它：`channel_send` 失败分两类——「内容不对」（名单外、找不到会话）与
 * 「此刻发不出去」（环境够不着）。后者**内容是对的**，只是那双手暂时不在。
 * 注：2026-10-09 起 `send_text` 走窗口消息投递、**锁屏不再是"发不出去"**，本队列兜
 * 「微信没跑 / 窗口不可见 / 切不过去」这类（判据 = Provider 的 `UNDELIVERABLE_CODES`）。
 * 原先没有这条队列时，这类失败只能靠人——回路写 pending.txt、转人工、还让用户去点/拖窗口。
 *
 * 分工：**渠道 Provider 是唯一的生产者**（它才看得见 `env_not_ready` 这个判定，
 * 见 `pcwechat-outbound-provider.ts`），**本回路是唯一的消费者**（它才每 15 秒跑一次、
 * 且这一步不需要模型）。补发时**直接调 `send_text`**：这些文本已经过完白名单校验、
 * 只差"手"那一步，重跑一遍模型回合既贵又可能换成另一句话——要发的就是当初那一句。
 */
const KV_KEY_OUTBOX = 'wechat_watch_outbox'
/** 上一回尝试补发的时刻（门关着时别每 15 秒去撞一次） */
const KV_KEY_OUTBOX_TRY = 'wechat_watch_outbox_try'
const OUTBOX_RETRY_MS = 60_000
/** 队列上限：锁一整天也最多攒这么多，超了丢最早的（迟到太久的问候不如不发） */
const OUTBOX_MAX = 20
/** 超过这个岁数就不再补发：几十分钟前的「早」发出去比不发更怪 */
const OUTBOX_TTL_MS = 30 * 60_000

export interface WechatOutboxItem {
  peer: string
  text: string
  /** 入队时刻（ms），仅用于排空顺序与日志 */
  at: number
}

export function readWechatOutbox(db: DatabaseAdapter): WechatOutboxItem[] {
  try {
    const row = db
      .prepare<{ value: string }>(`SELECT value FROM runtime_state WHERE key = ?`)
      .get(KV_KEY_OUTBOX) as { value: string } | undefined
    const arr = JSON.parse(row?.value ?? '[]')
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (x): x is WechatOutboxItem =>
        !!x && typeof x.peer === 'string' && typeof x.text === 'string' && !!x.peer && !!x.text,
    )
  } catch {
    return []
  }
}

/** 落盘待补发队列；返回是否写成功（失败只记日志，不抛）。 */
function writeWechatOutbox(db: DatabaseAdapter, items: readonly WechatOutboxItem[]): boolean {
  try {
    db.prepare(`INSERT OR REPLACE INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)`).run(
      KV_KEY_OUTBOX,
      JSON.stringify(items),
      new Date().toISOString(),
    )
    return true
  } catch (err) {
    log.warn('[wechat-watch] 待补发队列写入失败:', err)
    return false
  }
}

/**
 * 投递一条待补发（渠道 Provider 在 `env_not_ready` 时调）。
 *
 * 同一 (peer, text) 只留一条：回路重试/模型重述都可能送进同一句，队列不该因此变长。
 * 落盘失败会**抛出**：调用方（出站 Provider）据此照实报失败，而不是对外宣称「已排队」。
 */
export function enqueueWechatOutbox(db: DatabaseAdapter, peer: string, text: string): void {
  const bare = text.trim()
  if (!peer || !bare) return
  const cur = readWechatOutbox(db)
  if (cur.some((x) => x.peer === peer && x.text === bare)) return
  const next = [...cur, { peer, text: bare, at: Date.now() }].slice(-OUTBOX_MAX)
  if (!writeWechatOutbox(db, next)) throw new Error('待补发队列写入失败')
  log.info(`[wechat-watch] 发送门暂不可用，已排队待补发：${peer}（队列 ${next.length} 条）`)
}

/**
 * 把排队中的补发**按顺序**送出去（零模型）。门还关着就停下、留到下一拍。
 *
 * 送之前每条都先 `read_history(limit=1)` 复核：**末条是本人发的、且比这条入队还晚**才不再补——
 * 那才说明期间用户自己（或在别处）已经回过话了，这时候再把几十分钟前的草稿发出去只会更怪。
 * ⚠️ 判据必须带上「晚于入队时刻」：只看 `from_me` 会把**跟这条排队项毫无关系的旧消息**当成
 * 已送达（2026-10-09 15:34 实测：15:33 排队的「15:34」被 14:53 那条附件判成「本人已回过话」
 * 而丢弃，那条回复其实从没发出去）。排队项的 `text` 与最近那条 from_me 未必是同一句，
 * 所以比文本不如比时间。
 */
async function flushWechatOutbox(
  deps: WechatWatchDeps,
  nowMs: number,
  peers: readonly { id: string; label?: string }[] = [],
): Promise<string> {
  try {
    const db = deps.getDb()
    let queue = readWechatOutbox(db)
    if (queue.length === 0) return ''
    // 先扔掉过期的：锁一下午醒来再补「早上好」不如不补，也免得解禁那一刻一次倒出几十条
    const kept = queue.filter((x) => nowMs - x.at <= OUTBOX_TTL_MS)
    if (kept.length !== queue.length) {
      log.info(`[wechat-watch] 丢弃 ${queue.length - kept.length} 条过期待补发`)
      queue = kept
      writeWechatOutbox(db, queue)
    }
    if (queue.length === 0) return ''
    if (nowMs - readKvNumber(db, KV_KEY_OUTBOX_TRY) < OUTBOX_RETRY_MS) return ''
    writeKvNumber(db, KV_KEY_OUTBOX_TRY, nowMs) // 先记：门关着时这一撞的代价是完整的 bring_to_front
    let sent = 0
    for (const item of queue) {
      let repliedAfterQueue = false
      try {
        const raw = await deps.callMcpTool(WECHAT_WATCH_MCP_SERVER, 'read_history', {
          talker: item.peer,
          limit: 1,
        })
        const msgs = (JSON.parse(raw) as { messages?: { from_me?: boolean; ts?: number }[] })
          .messages
        const last = msgs?.[msgs.length - 1]
        // `ts` 是秒、`item.at` 是毫秒。读不到 ts 就当没回过话（宁可迟到，不可丢）
        repliedAfterQueue =
          last?.from_me === true && typeof last.ts === 'number' && last.ts * 1000 >= item.at
      } catch {
        repliedAfterQueue = false // 读不到就不拦（宁可迟到，不可丢）
      }
      if (repliedAfterQueue) {
        log.info(`[wechat-watch] 补发作废（本人已回过话）：${item.peer}`)
        queue = queue.filter((x) => x !== item)
        writeWechatOutbox(db, queue)
        continue
      }
      const out = await deps.callMcpTool(WECHAT_WATCH_MCP_SERVER, 'send_text', {
        talker: item.peer,
        text: item.text,
        dry_run: false,
      })
      const ok = (JSON.parse(out) as { ok?: boolean }).ok === true
      if (!ok) {
        // 门还关着（或这条本身发不出去了）：停在这里，剩下的下一拍再试，绝不重复发
        log.info(`[wechat-watch] 补发未成功，留队下一拍：${item.peer}`)
        break
      }
      sent += 1
      queue = queue.filter((x) => x !== item)
      writeWechatOutbox(db, queue)
      log.info(`[wechat-watch] 补发成功：${item.peer} → ${item.text.slice(0, 40)}`)
      // 当初那轮 channel_send 报的是「已排队」，会话里没有后续——这里把「已送达」补上
      const name = peers.find((p) => p.id === item.peer)?.label || item.peer
      deps.showNotification?.(
        `微信补发成功 · ${name}`,
        item.text,
        watchConversationIdFor(item.peer),
      )
    }
    return sent > 0 ? `补发 ${sent} 条` : ''
  } catch (err) {
    log.warn('[wechat-watch] 补发失败（不影响本拍）:', err)
    return ''
  }
}

/**
 * 空闲拍上的**画像巡检**：名单里还有人没有画像时，让代聊去建一份（一轮一个）。
 *
 * 为什么要有它：画像本来是「来消息 → 提示词里写着缺哪份 → 模型顺手建」自然长出来的，
 * 但那**依赖模型每一轮都照做**——漏一次就永久缺着，而缺画像恰恰是代聊口吻最不像的时候。
 * 这里是**兜底**：不依赖模型自觉，由回路按名单把它点出来。只在**没有新消息**的拍上跑，
 * 绝不和新消息抢这一轮。
 *
 * 返回一句放进任务页摘要的话（没做事就是空串）。
 */
async function maybeDistillProfiles(
  deps: WechatWatchDeps,
  peers: readonly { id: string; label?: string; mode: WatchMode }[],
  nowMs: number,
): Promise<string> {
  if (!deps.driveTurn) return ''
  try {
    const db = deps.getDb()
    if (nowMs - readKvNumber(db, KV_KEY_PROFILE_SWEEP) < PROFILE_SWEEP_INTERVAL_MS) return ''
    // 读一次已有画像：读不到（MCP 没连/返回怪形状）就**什么都别做**——
    // 拿不到清单时"以为缺"会变成每隔半小时空跑一轮模型
    const raw = await deps.callMcpTool(WECHAT_WATCH_MCP_SERVER, 'wechat_profile_get', {})
    const files = (JSON.parse(raw) as { files?: unknown }).files
    if (!Array.isArray(files)) return ''
    writeKvNumber(db, KV_KEY_PROFILE_SWEEP, nowMs) // 先记一拍：失败也不要在 15 秒后重来
    const target = pickProfileSweepTarget(peers, profileScopesFromFiles(files))
    if (!target) return ''
    const peer = target.id
    const name = target.label
    const result = await deps.driveTurn(buildProfileSweepPrompt(name, peer), {
      peer,
      convId: watchConversationIdFor(peer),
      title: watchConversationTitleFor(name, peer),
      mode: 'auto',
      incoming: [],
    })
    log.info(
      `[wechat-watch] 画像巡检·${name || peer}：${String(result).slice(0, 120)}`,
    )
    return `画像巡检·${name || peer}`
  } catch (err) {
    log.warn('[wechat-watch] 画像巡检失败（不影响本拍）:', err)
    return ''
  }
}

/**
 * 跑一拍。返回一句给 `cron_runs` 的摘要（任务页的「最近执行」能看到）。
 *
 * 注意：**任何失败路径都返回字符串、不抛**——这是 cron 的一次 tick，
 * 抛出去只会变成任务页上一条红色的 error，而门闩本来就该「失败=这拍什么都不做」。
 */
export async function runWechatWatch(deps: WechatWatchDeps): Promise<string> {
  const cfg = deps.config ?? loadWechatWatchConfig(deps.configPath)
  // 策略每拍读一次（设置页改完下一拍就生效，跟手册同一口径；存储层有内存缓存，不碰盘）
  let policy = deps.getPolicy?.() ?? policyFromWatchConfig(cfg)
  // 本机微信的本人 wxid（自聊识别用）。拿不到就给空数组，此时只认 filehelper。
  let selfWxids: readonly string[] = []
  try {
    selfWxids = (await deps.getSelfWxids?.()) ?? []
  } catch {
    selfWxids = []
  }
  const nowMs = deps.nowMs?.() ?? Date.now()
  const nowS = Math.floor(nowMs / 1000)
  try {
    if (!cfg.enabled) return '（盯梢已关闭：配置 enabled=false）'
    const db = deps.getDb()
    // 自聊 peer（文件传输助手 / 本人 wxid）默认加入名单且可回 —— 用户显式要的"当作入站渠道"。
    // **一次性**迁移：旧装机把 filehelper 播种成了黑名单(ignore)，第一次把它纠成 auto 并落盘；
    // 之后只补缺不覆盖（用户在设置页把它改回 ignore/notify 是用户的选择，尊重）。
    {
      const migratedKey = 'wechat_watch_selfpeer_migrated'
      const migrated = readKvNumber(db, migratedKey) > 0
      const withSelf = withSelfPeers(policy, selfWxids, { flipIgnore: !migrated })
      if (withSelf.changed) {
        policy = withSelf.policy
        deps.setPolicy?.(policy)
        log.info('[wechat-watch] 文件传输助手/本人账号已加入名单（可回）')
      }
      if (!migrated) writeKvNumber(db, migratedKey, nowMs)
    }
    const since = readLastTs(db) ?? nowS // 首次：从现在起，不翻历史
    let payload: PollPayload | null = null
    try {
      const t0 = Date.now()
      const text = await deps.callMcpTool(WECHAT_WATCH_MCP_SERVER, WECHAT_WATCH_MCP_TOOL, {
        since_ts: since,
      })
      const cost = Date.now() - t0
      if (cost > 2000) {
        // 观测用：读取侧正常是几十毫秒；偶发几秒的话，先分清是 MCP 侧还是主进程阻塞
        log.warn(`[wechat-watch] poll_new 耗时 ${cost}ms（读取侧正常 <100ms，值得看一眼）`)
      }
      payload = JSON.parse(text) as PollPayload
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // 客户端**不依赖** wechat-local 这个 MCP：没装/没连/被禁用时，这里安静跳过即可
      // （用户可能把这台机器上的 MCP 只给别的 AI 工具用，也可能压根没用微信）
      if (msg.includes('未连接')) {
        return '（wechat-local MCP 未连接，本拍跳过）'
      }
      log.warn('[wechat-watch] poll_new 调用失败，本拍跳过：', err)
      return `poll 失败，本拍跳过：${msg}`
    }
    const messages = Array.isArray(payload?.messages) ? payload!.messages! : []
    const next = Number(payload?.next_since_ts ?? since)
    if (Number.isFinite(next) && next > 0) writeLastTs(db, next) // 无论报不报都要推进，免得重复读
    const fresh = selectNewMessages(messages, policy, selfWxids).filter(
      // 自聊回环护栏：助手刚发出去的话会以 from_me 再出现，按文本跳过（普通会话不会走到这里）
      (m) => !(isSelfChatPeer(m.talker, selfWxids) && wasSelfSent(m.talker || '', m.text, nowMs)),
    )
    pruneOwnRuns(db)
    // 画像巡检只针对**人**：自聊（文件传输助手/本人账号）不是"某个人"，给它蒸馏画像是白花 token
    const personPeers = policy.peers.filter((p) => !isSelfChatPeer(p.id, selfWxids))
    if (fresh.length === 0) {
      // 空闲拍：先把锁屏/抢不到前台时积压的送出去（见 flushWechatOutbox），
      // 再给名单里还没有画像的人补一张（见 maybeDistillProfiles）。
      // 两件都只在空闲拍做——有活回合时它们会跟这一轮抢那双手和那个端点。
      const flushed = await flushWechatOutbox(deps, nowMs, policy.peers)
      const swept = await maybeDistillProfiles(deps, personPeers, nowMs)
      const base = messages.length > 0 ? `新消息 ${messages.length} 条（均被过滤，不报）` : '无新消息'
      return [base, flushed, swept].filter(Boolean).join('｜')
    }

    // 同一会话这拍里的多条合并成一次动作（一条消息一个回合会太吵，也浪费）
    const byPeer = new Map<string, WechatMessage[]>()
    for (const m of fresh) {
      const key = m.talker || m.name || '?'
      const arr = byPeer.get(key)
      if (arr) arr.push(m)
      else byPeer.set(key, [m])
    }

    // 护栏与口径**住在哪**：M3 起唯一真源是「灵栖代聊」的 systemPrompt（每轮自动带上，零重复 token）。
    // 代聊 Agent 不在，就退回每轮注入（程序分区 + 用户手册全文）——护栏不能因为少了个 Agent 就消失。
    //
    // 这里不再比对「手册文件 vs Agent 里那份」：手册已**整段移出**提示词（见
    // wechat-relay-agent.ts 的 M3 说明），两边本来就该不一样，比对只会变成永久假警告。
    const runbook = loadInstructions(cfg.instructionsFile)  // 每拍读一次（手册可能随时被改）
    const relayAgent = deps.getRelayAgent?.()
    const injectRunbook = relayAgent ? '' : runbook
    const notifyOnly: WechatMessage[] = []
    const notifyConvIds = new Set<string>()
    const acted: string[] = []
    const actedConvIds = new Set<string>()
    const cooldown = readCooldowns(db)
    let cooldownDirty = false

    // 「你自己刚回过了」也算一次动作：用户可能在手机/PC 上亲自回了，也可能在「微信盯梢」
    // 会话里手动说「发」。不加这一条，watcher 会在他刚回完的头上再替他回一遍（**双重代聊**，
    // 现场实测过：16:40:42 用户手动发了一条，watcher 12 秒后也在同一会话动作）。
    const nowForSent = deps.nowMs?.() ?? Date.now()
    for (const m of messages) {
      if (!m.from_me) continue
      // 自聊会话的 from_me **不代表"用户刚手动回了"**（那正是用户发给助手的消息本身），
      // 给它推冷却会把刚到的入站消息直接降级成提醒、代聊永远收不到——跳过。
      if (isSelfChatPeer(m.talker, selfWxids)) continue
      const key = m.talker || m.name || '?'
      if ((cooldown[key] ?? 0) < nowForSent) {
        cooldown[key] = nowForSent
        cooldownDirty = true
      }
    }

    for (const [peer, msgs] of byPeer) {
      const last = msgs[msgs.length - 1]
      // 人名条目在这里自愈成真 wxid（此刻才知道 talker↔名字的对应），改动立即落盘
      const healed = healPeerBinding(policy, { id: last.talker, label: last.name })
      if (healed) {
        policy = healed
        deps.setPolicy?.(healed)
        log.info(
          `[wechat-watch] 名单里的人名条目「${last.name}」已绑到真 wxid（${last.talker}）`,
        )
      }
      const { mode, cooldownSeconds: cd, matchedBy } = resolvePeerPolicy(policy, {
        id: last.talker,
        label: last.name,
      })
      const convId = watchConversationIdFor(peer)
      if (mode === 'notify') {
        notifyOnly.push(...msgs)
        notifyConvIds.add(convId)
        continue
      }
      const nowMsNow = deps.nowMs?.() ?? Date.now()
      if ((cooldown[peer] ?? 0) + cd * 1000 > nowMsNow) {
        // 冷却期内不打扰对方（也不叫模型）。自聊会话**静默跳过**，不降级成提醒——
        // 冷却内多半就是助手自己刚回的那条（或用户同一波连发），提醒只会自己刷自己。
        if (!isSelfChatPeer(last.talker, selfWxids)) {
          notifyOnly.push(...msgs)
          notifyConvIds.add(convId)
        }
        continue
      }
      if (!deps.driveTurn) {
        notifyOnly.push(...msgs)
        notifyConvIds.add(convId)
        continue
      }
      const prompt =
        mode === 'auto'
          ? buildAutoPrompt(last, injectRunbook, cfg.instructionsFile)
          : buildDraftPrompt(last, injectRunbook, cfg.instructionsFile)
      let result = ''
      try {
        result = await deps.driveTurn(prompt, {
          peer,
          convId,
          title: watchConversationTitleFor(last.name, peer),
          mode,
          incoming: msgs,
        })
      } catch (err) {
        log.error(`[wechat-watch] 驱动回合失败（${peer}）：`, err)
        result = `回合失败：${err instanceof Error ? err.message : String(err)}`
      }
      cooldown[peer] = nowMsNow
      cooldownDirty = true
      // **读库实测**这一轮到底发没发（回合的说法只是文本）：
      // - auto：真发了才敢写「已代回」；没发就写「未发」，别替它邀功；
      // - draft：本不该发，真发了要标 ⚠️ 告知用户。
      const sentInfo = await detectSentTo(deps, last, last.ts)
      const sent = sentInfo.sent
      // 记住"我们刚发出去的话"：下一拍它会以 from_me 再出现，自聊会话按文本跳过（防自回环）
      rememberSelfSends(last.talker || peer, sentInfo.texts, nowMsNow)
      const label =
        mode === 'auto' ? (sent ? '已代回' : '未发') : sent ? '草稿⚠️疑似已发出' : '草稿'
      acted.push(`${label}·${last.name || peer}：${(last.text || '').slice(0, 40)}`)
      actedConvIds.add(convId)
      log.info(
        `[wechat-watch] ${mode} 完成（${peer}，策略来自${matchedBy ? `「${matchedBy}」` : '默认档'}，sent=${sent}）：${result.slice(0, 160)}`,
      )
    }
    if (cooldownDirty) writeCooldowns(db, cooldown)

    if (notifyOnly.length > 0 && cfg.notify) {
      try {
        // 点通知直达那个好友的会话（只涉及一个会话时才给跳转目标）
        deps.showNotification?.(
          `微信新消息（${notifyOnly.length}）`,
          formatWechatNotice(notifyOnly),
          soleConvId(notifyConvIds),
        )
      } catch (err) {
        log.warn('[wechat-watch] 通知发送失败：', err)
      }
    }
    if (acted.length > 0 && cfg.notify) {
      try {
        deps.showNotification?.(
          `微信盯梢：${acted.length} 个会话已处理`,
          acted.join('\n'),
          soleConvId(actedConvIds),
        )
      } catch (err) {
        log.warn('[wechat-watch] 通知发送失败：', err)
      }
    }
    const parts: string[] = []
    if (acted.length > 0) parts.push(acted.join('；'))
    if (notifyOnly.length > 0) parts.push(`提醒 ${notifyOnly.length} 条`)
    // 这行在任务页是用户唯一能看出"护栏到底在不在"的地方：
    // 护栏的口径（硬停/软回/放行 + 工作流）住在代聊 Agent 的程序分区里，
    // 它不在时才退回每轮注入。
    if (parts.length > 0) {
      if (relayAgent) parts.push('护栏在「灵栖代聊」里')
      else parts.push(runbook ? '带护栏+手册' : '带护栏')
    }
    return parts.join('｜') || '无新消息'
  } catch (err) {
    log.error('[wechat-watch] 本拍异常：', err)
    return `本拍异常：${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * 播种 cron（存在则把形态改回来，与 pet-sensing 同一套口径）。
 *
 * **只在 `wechat-local` 这个 MCP Server 被配置且启用时才建/保留这条任务**：
 * 客户端不依赖微信 MCP——用户可能把这台机器上的 MCP 只给别的 AI 工具用、也可能根本不用微信，
 * 那时任务列表里不该出现一条永远「未连接」的循环。反过来，启用 MCP 后下次启动会自动建好。
 * 用户自己的启停（任务页开关）不会被这里覆盖。
 */
export function ensureWechatWatchCronJobSeeded(
  db: DatabaseAdapter,
  opts: { mcpConfigured: boolean },
): void {
  try {
    const existing = db
      .prepare<{ id: string }>(`SELECT id FROM local_cron_jobs WHERE id = ?`)
      .get(WECHAT_WATCH_CRON_ID)
    if (!opts.mcpConfigured) {
      if (existing) {
        db.prepare(`UPDATE local_cron_jobs SET enabled = 0 WHERE id = ?`).run(WECHAT_WATCH_CRON_ID)
        log.info(
          `[ensureWechatWatchCronJobSeeded] wechat-local MCP 未配置/未启用，暂停 job id=${WECHAT_WATCH_CRON_ID}`,
        )
      }
      return
    }
    if (existing) {
      db.prepare(
        `UPDATE local_cron_jobs SET interval_ms = ?, agent_id = NULL,
         schedule_type = 'every', schedule_expr = '', notify_targets = NULL
         WHERE id = ?`,
      ).run(WECHAT_WATCH_INTERVAL_MS, WECHAT_WATCH_CRON_ID)
      ensureWechatWatchConfigFile()
      return
    }
    const now = Date.now()
    db.prepare(
      `INSERT INTO local_cron_jobs
       (id, name, task_text, agent_id, schedule_type, schedule_expr, next_run_at, interval_ms, enabled, created_at)
       VALUES (?, ?, ?, NULL, 'every', '', ?, ?, 1, ?)`,
    ).run(
      WECHAT_WATCH_CRON_ID,
      WECHAT_WATCH_NAME,
      WECHAT_WATCH_INSTRUCTION,
      now,
      WECHAT_WATCH_INTERVAL_MS,
      now,
    )
    log.info(
      `[ensureWechatWatchCronJobSeeded] 新建 job id=${WECHAT_WATCH_CRON_ID} intervalMs=${WECHAT_WATCH_INTERVAL_MS}`,
    )
    ensureWechatWatchConfigFile()
  } catch (err) {
    log.error('[ensureWechatWatchCronJobSeeded] 失败:', err)
  }
}
