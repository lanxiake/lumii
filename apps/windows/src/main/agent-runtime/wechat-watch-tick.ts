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
import { agentRuntimeLog as log } from './bridge-utils'

export const WECHAT_WATCH_INSTRUCTION = '__wechat_watch__'
/**
 * 数据源（MCP Server 名 + 工具名）：**客户端与 wechat-mcp 解耦**——这里只依赖
 * 「有个 MCP Server 暴露了一个 `poll_new(since_ts)`」这个契约。没配/没连/被禁用时
 * 盯梢安静跳过（见 `runWechatWatch` 的「未连接」分支），客户端不因此不可用。
 */
export const WECHAT_WATCH_MCP_SERVER = 'wechat-local'
const WECHAT_WATCH_MCP_TOOL = 'poll_new'
const WECHAT_WATCH_CRON_ID = 'wechat-watch'
const WECHAT_WATCH_NAME = '微信消息盯梢'
const WECHAT_WATCH_INTERVAL_MS = 15_000

/** 水位键：报过的最新消息 ts（秒）。重启后从这里续读 */
const KV_KEY_LAST_TS = 'wechat_watch_last_ts'
/** 通知里最多列几条（其余折叠成一句） */
const MAX_NOTIFY_ITEMS = 3

/**
 * 对某个会话的处理方式。
 *
 * - `ignore`  完全不处理（黑名单 / 未列入且默认就是忽略）
 * - `notify`  只提醒我（不打扰对方，也不叫模型）
 * - `draft`   叫醒模型**起草**，草稿落在「微信盯梢」会话里等我点头（我不会不知情地被代表）
 * - `auto`    直接以我本人身份回（白名单专用：仍有冷却与「发完必报」）
 */
export type WatchMode = 'ignore' | 'notify' | 'draft' | 'auto'

/** 一个分组的策略：把「谁能替我用哪种方式回」写成一张表 */
export interface WechatWatchGroup {
  /** 分组名（只用于日志/通知里说明是谁） */
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
  /** 不在任何分组里的会话怎么处理（默认只提醒；想「只盯名单」就设成 ignore） */
  defaultMode: WatchMode
  /** 永不处理（连提醒都不发）：默认忽略「文件传输助手」这类自用会话 */
  blacklist: string[]
  /** 分组策略（先匹配到的分组生效） */
  groups: WechatWatchGroup[]
}

export const DEFAULT_WECHAT_WATCH_CONFIG: WechatWatchConfig = {
  enabled: true,
  notify: true,
  defaultMode: 'notify',
  blacklist: ['filehelper'],
  groups: [],
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
        '微信消息盯梢：enabled=总开关；notify=是否弹系统通知；defaultMode=不在分组里的会话怎么处理（ignore/notify/draft/auto）；blacklist=永不处理；groups=分组策略（{name, mode, peers:[名字或 wxid/群号], cooldownSeconds}）。mode 含义：notify=只提醒我；draft=让助手起草、我点头才发；auto=直接替我回（建议只给信得过的人，cooldownSeconds 默认 60）。改完存盘即生效，不用重启。',
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
  // ── v1 兼容 ──
  if (out.groups.length === 0 && asStringArray(o.watch)?.length) {
    out.groups = [{ name: '白名单', mode: 'notify', peers: asStringArray(o.watch)! }]
    if (o.defaultMode === undefined) out.defaultMode = 'ignore'
  }
  const legacyIgnore = asStringArray(o.ignore)
  if (legacyIgnore && !blacklist) out.blacklist = legacyIgnore
  return out
}

/** 会话按分组策略该走哪一档；命中的分组名一并返回（通知/日志里说明依据） */
export function resolveWatchMode(
  msg: Pick<WechatMessage, 'name' | 'talker'>,
  cfg: WechatWatchConfig,
): { mode: WatchMode; group: string | null } {
  const norm = (s: string) => s.trim().toLowerCase()
  const keys = [msg.talker, msg.name].filter((x): x is string => !!x).map(norm)
  if (keys.some((k) => cfg.blacklist.map(norm).includes(k))) {
    return { mode: 'ignore', group: null }
  }
  for (const g of cfg.groups) {
    const peers = g.peers.map(norm)
    if (keys.some((k) => peers.includes(k))) return { mode: g.mode, group: g.name }
  }
  return { mode: cfg.defaultMode, group: null }
}

/** 某个会话的冷却时长（秒）：命中分组用分组的，否则 60 */
export function cooldownSecondsFor(
  msg: Pick<WechatMessage, 'name' | 'talker'>,
  cfg: WechatWatchConfig,
): number {
  const norm = (s: string) => s.trim().toLowerCase()
  const keys = [msg.talker, msg.name].filter((x): x is string => !!x).map(norm)
  for (const g of cfg.groups) {
    if (keys.some((k) => g.peers.map(norm).includes(k))) {
      return g.cooldownSeconds ?? DEFAULT_COOLDOWN_S
    }
  }
  return DEFAULT_COOLDOWN_S
}

const DEFAULT_COOLDOWN_S = 60

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
}

/** `poll_new` 的返回（只声明这条循环用到的字段） */
interface PollPayload {
  messages?: WechatMessage[]
  next_since_ts?: number
}

/**
 * 挑出「要处理」的消息：**只处理别人发的**（自己发的不必提醒自己），
 * 黑名单与 ignore 档一律剔除（连提醒都不给）。
 */
export function selectNewMessages(
  messages: readonly WechatMessage[],
  cfg: WechatWatchConfig,
): WechatMessage[] {
  return messages.filter((m) => !m.from_me && resolveWatchMode(m, cfg).mode !== 'ignore')
}

const fmtText = (s?: string) => (s || '').replace(/\s+/g, ' ').slice(0, 300)
const fmtWhen = (ts: number) => new Date(ts * 1000).toLocaleString('zh-CN')

/** 起草模式的提示词：看上下文 → 写草稿 → **明确不许发** */
export function buildDraftPrompt(msg: WechatMessage, group: string | null): string {
  const who = msg.name || msg.talker || '对方'
  return [
    `微信「${who}」刚给我发来消息（${fmtWhen(msg.ts)}）：`,
    `「${fmtText(msg.text)}」`,
    group ? `（这个会话在「${group}」分组里，策略：起草给我确认，不要直接发。）` : '',
    '',
    '请做两件事：',
    `1. 用 wechat-local 的 read_history 看一眼我和「${who}」最近的对话（talker 用 ${msg.talker}），把握语气与上下文；`,
    '2. 起草一条**以我本人身份**发出的回复（像我平时说话：短、自然，别用敬语腔，别暴露你是助手）。',
    '',
    '⚠️ 现在**只起草、不要发送**（不要调用 send_text）——把草稿写在回复里给我看，',
    '我会回你「发」或给你修改意见；我说「发」时你再用 send_text 发出去。',
  ]
    .filter(Boolean)
    .join('\n')
}

/** 自动回模式的提示词：允许直接发，但要求发完自报「发了什么」 */
export function buildAutoPrompt(msg: WechatMessage, group: string | null): string {
  const who = msg.name || msg.talker || '对方'
  return [
    `微信「${who}」刚给我发来消息（${fmtWhen(msg.ts)}）：`,
    `「${fmtText(msg.text)}」`,
    group ? `（这个会话在「${group}」分组里，策略：**允许直接替我回**。）` : '',
    '',
    '请：',
    `1. 用 wechat-local 的 read_history 看一眼我和「${who}」最近的对话（talker 用 ${msg.talker}）；`,
    `2. 以我本人身份直接回复（用 wechat-local 的 send_text，talker=${msg.talker}）——短发、自然、像我平时说话；`,
    '   不确定、敏感、或涉及承诺/金钱/时间安排时**不要猜**：改为只把草稿写给我看，等我定；',
    '3. 回复里告诉我你发出去的原文；没发就说明为什么。',
    '',
    '注意：不暴露你是助手；不编造我不知道的事实；对话不连贯时宁可少说。',
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
): Promise<boolean> {
  try {
    const text = await deps.callMcpTool(WECHAT_WATCH_MCP_SERVER, WECHAT_WATCH_MCP_TOOL, {
      since_ts: since,
    })
    const payload = JSON.parse(text) as PollPayload
    return (payload.messages ?? []).some(
      (m) => m.from_me && (m.talker === msg.talker || (!!m.name && m.name === msg.name)),
    )
  } catch {
    return false
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
  /** 系统通知（第三个参数是会话 id，点击可跳到「微信盯梢」会话） */
  showNotification?: (title: string, body: string, convId?: string) => void
  /**
   * 驱动一次 Agent 回合（bridge 注入）。
   *
   * 没有它时 draft/auto 一律降级为「通知」——这条循环的核心是**不依赖**某个具体接线，
   * 缺哪个部件就退到哪一档，绝不半途出错。
   */
  driveTurn?: (prompt: string, meta: { peer: string; mode: WatchMode; group: string | null }) => Promise<string>
  /** 覆盖配置路径（测试用） */
  configPath?: string
  /** 直接给定配置（测试用；给了就不读文件） */
  config?: WechatWatchConfig
  /** 时间源（测试用） */
  nowMs?: () => number
}

/** 「微信盯梢」会话 id：草稿与代回都发生在这里，用户能翻能追 */
export const WECHAT_WATCH_CONV_ID = 'wechat:watch'

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

/**
 * 跑一拍。返回一句给 `cron_runs` 的摘要（任务页的「最近执行」能看到）。
 *
 * 注意：**任何失败路径都返回字符串、不抛**——这是 cron 的一次 tick，
 * 抛出去只会变成任务页上一条红色的 error，而门闩本来就该「失败=这拍什么都不做」。
 */
export async function runWechatWatch(deps: WechatWatchDeps): Promise<string> {
  const cfg = deps.config ?? loadWechatWatchConfig(deps.configPath)
  const nowMs = deps.nowMs?.() ?? Date.now()
  const nowS = Math.floor(nowMs / 1000)
  try {
    if (!cfg.enabled) return '（盯梢已关闭：配置 enabled=false）'
    const db = deps.getDb()
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
    const fresh = selectNewMessages(messages, cfg)
    pruneOwnRuns(db)
    if (fresh.length === 0) {
      return messages.length > 0 ? `新消息 ${messages.length} 条（均被过滤，不报）` : '无新消息'
    }

    // 同一会话这拍里的多条合并成一次动作（一条消息一个回合会太吵，也浪费）
    const byPeer = new Map<string, WechatMessage[]>()
    for (const m of fresh) {
      const key = m.talker || m.name || '?'
      const arr = byPeer.get(key)
      if (arr) arr.push(m)
      else byPeer.set(key, [m])
    }

    const notifyOnly: WechatMessage[] = []
    const acted: string[] = []
    const cooldown = readCooldowns(db)
    let cooldownDirty = false

    // 「你自己刚回过了」也算一次动作：用户可能在手机/PC 上亲自回了，也可能在「微信盯梢」
    // 会话里手动说「发」。不加这一条，watcher 会在他刚回完的头上再替他回一遍（**双重代聊**，
    // 现场实测过：16:40:42 用户手动发了一条，watcher 12 秒后也在同一会话动作）。
    const nowForSent = deps.nowMs?.() ?? Date.now()
    for (const m of messages) {
      if (!m.from_me) continue
      const key = m.talker || m.name || '?'
      if ((cooldown[key] ?? 0) < nowForSent) {
        cooldown[key] = nowForSent
        cooldownDirty = true
      }
    }

    for (const [peer, msgs] of byPeer) {
      const last = msgs[msgs.length - 1]
      const { mode, group } = resolveWatchMode(last, cfg)
      if (mode === 'notify') {
        notifyOnly.push(...msgs)
        continue
      }
      const cd = cooldownSecondsFor(last, cfg)
      const nowMsNow = deps.nowMs?.() ?? Date.now()
      if ((cooldown[peer] ?? 0) + cd * 1000 > nowMsNow) {
        // 冷却期内不打扰对方（也不叫模型），降级成提醒——用户仍然看得见
        notifyOnly.push(...msgs)
        continue
      }
      if (!deps.driveTurn) {
        notifyOnly.push(...msgs)
        continue
      }
      const prompt =
        mode === 'auto'
          ? buildAutoPrompt(last, group)
          : buildDraftPrompt(last, group)
      let result = ''
      try {
        result = await deps.driveTurn(prompt, { peer, mode, group })
      } catch (err) {
        log.error(`[wechat-watch] 驱动回合失败（${peer}）：`, err)
        result = `回合失败：${err instanceof Error ? err.message : String(err)}`
      }
      cooldown[peer] = nowMsNow
      cooldownDirty = true
      // **读库实测**这一轮到底发没发（回合的说法只是文本）：
      // - auto：真发了才敢写「已代回」；没发就写「未发」，别替它邀功；
      // - draft：本不该发，真发了要标 ⚠️ 告知用户。
      const sent = await detectSentTo(deps, last, last.ts)
      const label =
        mode === 'auto' ? (sent ? '已代回' : '未发') : sent ? '草稿⚠️疑似已发出' : '草稿'
      acted.push(`${label}·${last.name || peer}：${(last.text || '').slice(0, 40)}`)
      log.info(`[wechat-watch] ${mode} 完成（${peer}/${group ?? '默认'}，sent=${sent}）：${result.slice(0, 160)}`)
    }
    if (cooldownDirty) writeCooldowns(db, cooldown)

    if (notifyOnly.length > 0 && cfg.notify) {
      try {
        deps.showNotification?.(`微信新消息（${notifyOnly.length}）`, formatWechatNotice(notifyOnly),
          acted.length > 0 ? WECHAT_WATCH_CONV_ID : undefined)
      } catch (err) {
        log.warn('[wechat-watch] 通知发送失败：', err)
      }
    }
    if (acted.length > 0 && cfg.notify) {
      try {
        deps.showNotification?.(
          `微信盯梢：${acted.length} 个会话已处理`,
          acted.join('\n'),
          WECHAT_WATCH_CONV_ID,
        )
      } catch (err) {
        log.warn('[wechat-watch] 通知发送失败：', err)
      }
    }
    const parts: string[] = []
    if (acted.length > 0) parts.push(acted.join('；'))
    if (notifyOnly.length > 0) parts.push(`提醒 ${notifyOnly.length} 条`)
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
