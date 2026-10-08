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

export interface WechatWatchConfig {
  /** 总开关（任务页暂停也能停） */
  enabled: boolean
  /**
   * 只盯这些会话（名字或 wxid/群号）；空数组 = 全部会话。
   * 用于「只想盯几个重要的人」的场景，避免群消息刷屏。
   */
  watch: string[]
  /** 永不报告：默认忽略「文件传输助手」这类自用会话 */
  ignore: string[]
  /** 是否发系统通知 */
  notify: boolean
}

export const DEFAULT_WECHAT_WATCH_CONFIG: WechatWatchConfig = {
  enabled: true,
  watch: [],
  ignore: ['filehelper'],
  notify: true,
}

/** 配置文件路径（用户可手改；`LUMII_CLIENT_DATA_DIR` 生效，便于隔离测试） */
export function wechatWatchConfigPath(): string {
  return path.join(resolveWindowsClientDataRoot(), 'wechat-watch.json')
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
}

/**
 * 读配置：缺文件/坏 JSON/字段类型不对 **一律退回默认值**，绝不抛——
 * 盯梢是后台循环，不能因为用户手改坏一行就把整拍炸掉。
 */
export function parseWechatWatchConfig(raw: unknown): WechatWatchConfig {
  const out: WechatWatchConfig = { ...DEFAULT_WECHAT_WATCH_CONFIG }
  if (!raw || typeof raw !== 'object') return out
  const o = raw as Record<string, unknown>
  if (typeof o.enabled === 'boolean') out.enabled = o.enabled
  if (typeof o.notify === 'boolean') out.notify = o.notify
  const watch = asStringArray(o.watch)
  if (watch) out.watch = watch
  const ignore = asStringArray(o.ignore)
  if (ignore) out.ignore = ignore
  return out
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
}

/** `poll_new` 的返回（只声明这条循环用到的字段） */
interface PollPayload {
  messages?: WechatMessage[]
  next_since_ts?: number
}

/**
 * 挑出「值得报告」的消息：**只报别人发的**（自己发的不必提醒自己），
 * 再按 watch/ignore 过滤（watch 非空 = 白名单；ignore 永远优先）。
 */
export function selectNewMessages(
  messages: readonly WechatMessage[],
  cfg: WechatWatchConfig,
): WechatMessage[] {
  const norm = (s: string) => s.trim().toLowerCase()
  const watch = cfg.watch.map(norm)
  const ignore = cfg.ignore.map(norm)
  return messages.filter((m) => {
    if (m.from_me) return false
    const keys = [m.talker, m.name].filter((x): x is string => !!x).map(norm)
    if (keys.some((k) => ignore.includes(k))) return false
    if (watch.length > 0 && !keys.some((k) => watch.includes(k))) return false
    return true
  })
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
  /** 系统通知（用户在做别的事时也能看到） */
  showNotification?: (title: string, body: string) => void
  /** 覆盖配置路径（测试用） */
  configPath?: string
  /** 直接给定配置（测试用；给了就不读文件） */
  config?: WechatWatchConfig
  /** 时间源（测试用） */
  nowMs?: () => number
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
      const text = await deps.callMcpTool(WECHAT_WATCH_MCP_SERVER, WECHAT_WATCH_MCP_TOOL, {
        since_ts: since,
      })
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
    if (fresh.length === 0) {
      pruneOwnRuns(db)
      return messages.length > 0 ? `新消息 ${messages.length} 条（均被过滤，不报）` : '无新消息'
    }
    const body = formatWechatNotice(fresh)
    if (cfg.notify) {
      try {
        deps.showNotification?.(`微信新消息（${fresh.length}）`, body)
      } catch (err) {
        log.warn('[wechat-watch] 通知发送失败：', err)
      }
    }
    log.info(`[wechat-watch] 新消息 ${fresh.length} 条：${body}（水位 → ${next}）`)
    return `新消息 ${fresh.length} 条：${body}`
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
  } catch (err) {
    log.error('[ensureWechatWatchCronJobSeeded] 失败:', err)
  }
}
