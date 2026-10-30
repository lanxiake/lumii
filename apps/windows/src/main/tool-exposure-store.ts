/**
 * `tool_exposure_log` —— 「这一轮，模型看到了哪些工具」。
 *
 * **为什么要有这张表**：仓库此前只记「工具被调用」，从不记「工具被展示」。
 * 于是有两个问题永远答不了：
 *
 * 1. **「没用」与「没机会用」分不开**。179 个工具里 57 个只被用过 1–3 次，
 *    但没有任何证据说明它们是「不值得占位」还是「模型根本没看见」。
 * 2. **裁剪是否伤到模型无法证伪**。能力面设计 §5.6.6 明确标注：回放算出的 93.5%
 *    Recall 是**上界**，因为一旦开始裁剪，模型看到的面变了、行为也会变。
 *    要测这个，必须能把「这轮装了哪些工具」与「这轮实际调了哪些工具」对上——
 *    前者此前根本不存在。
 *
 * **为什么一轮一行而不是一工具一行**：一行里放 JSON 数组，日均 400 轮 ≈ 80KB/天，
 * 比 `tool_audit_log` 的 46K 行还小。拆成一工具一行会把行数乘 20，而查询永远是
 * 「这一轮的全部工具」，拆开只会让每次读都要 GROUP BY 再把数组拼回来。
 *
 * **为什么 tools 里连 token 一起存**（而不是只存名字）：
 * 回答「谁最贵」需要逐工具成本，而聚合值（日志里的 `tools:9476`）分摊不到个体。
 * 多这一层在写入时几乎零成本，省掉一次未来的迁移。
 *
 * 写失败静默（`tool-usage-store.ts` 头注释的同一条约定）：统计绝不影响对话。
 */

import type { DatabaseAdapter } from '@mtbot/agent-runtime'

/** 暴露记录保留天数：与 `tool_usage_daily` 同一口径，90 天 */
export const EXPOSURE_RETENTION_DAYS = 90

/** 单条工具在当轮的暴露成本 */
export interface ExposedTool {
  /** 工具名（`bash` / `mcp__wechat-local__read_history`） */
  readonly n: string
  /** 该工具的 schema 估算 tokens */
  readonly t: number
}

export interface ExposureRecord {
  /** 会话 key（`ConversationRepo` 的主键口径） */
  readonly sessionKey: string
  /** 触发本轮的用户消息 id；取不到留 null，**不编造** */
  readonly turnId?: string | null
  /** Agent **定义 id**（`chronicler`），不是实例 id——实例不落库，等于解不开的外键 */
  readonly agentId: string
  /** 会话归属渠道（`ipc` / `weixin` / `feishu` / `pcwechat` / `cron` / `evolution` / `unknown`） */
  readonly channel: string
  /** 当轮暴露的全部工具 */
  readonly tools: readonly ExposedTool[]
  /**
   * 为什么记这一行：
   * - `turn`：开轮装配（默认）
   * - `search`：轮内因 `tool_search` 命中而追加装载（P2 才会出现）
   *
   * 同 `turnId` 下先 `turn` 后 `search`，就是「模型自己把它捞回来了」的证据。
   */
  readonly reason?: 'turn' | 'search'
}

let dbAdapter: DatabaseAdapter | null = null

export function initToolExposureStore(db: DatabaseAdapter | null | undefined): void {
  if (!db) return
  dbAdapter = db
}

/**
 * 记一行暴露记录。
 *
 * **绝不抛异常**：调用点在 `BridgePromptDispatcher.prompt()` 的主路径上，
 * 统计失败让用户发不出消息是不可接受的。未注入库时静默丢弃。
 */
export function recordToolExposure(rec: ExposureRecord): void {
  if (!dbAdapter) return
  const tools = rec.tools.slice()
  const totalTokens = tools.reduce((sum, t) => sum + (Number.isFinite(t.t) ? t.t : 0), 0)
  try {
    dbAdapter
      .prepare(
        `INSERT INTO tool_exposure_log
           (created_at, session_key, turn_id, agent_id, channel, tool_count, total_tokens, tools, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        rec.sessionKey,
        rec.turnId ?? null,
        rec.agentId,
        rec.channel,
        tools.length,
        totalTokens,
        JSON.stringify(tools),
        rec.reason ?? 'turn',
      )
  } catch (err) {
    console.error('[ToolExposureStore] 写入失败（已忽略，不影响对话）:', err)
  }
}

/** 清理超过保留期的行；返回删除行数（失败返回 0，不抛） */
export function pruneToolExposure(now: number = Date.now()): number {
  if (!dbAdapter) return 0
  const cutoff = now - EXPOSURE_RETENTION_DAYS * 24 * 60 * 60 * 1000
  try {
    const res = dbAdapter.prepare('DELETE FROM tool_exposure_log WHERE created_at < ?').run(cutoff)
    return res.changes ?? 0
  } catch (err) {
    console.error('[ToolExposureStore] 清理过期暴露记录失败（已忽略）:', err)
    return 0
  }
}

/** 仅测试用：重置模块内存态 */
export function __resetToolExposureStoreForTest(): void {
  dbAdapter = null
}

