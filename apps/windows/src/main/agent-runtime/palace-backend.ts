/**
 * 记忆宫殿的宿主侧接线（自建 SQLite）
 *
 * 动因（评审 2026-09-17 §4.6 / 自建记忆宫殿实施计划 T5）：宫殿原由 MemPalace
 * （Python MCP + chromadb）承载——本机 chromadb 的 Rust 内核 upsert 直接 0xC0000005 崩溃，
 * 且 `palace_drawer_id` 覆盖率实测只有 4/171 = 2.3%。换句话说，「过去说过什么」这条
 * 召回路径**实际上从来不存在**，降级路径是「grep 两个 Markdown 文件」。
 * 2026-09-18 起 MemPalace 的代码（MCP 客户端、Python 运行时安装、IPC 通道、插件 UI）
 * 已整体删除，只剩自建实现这一条路。
 *
 * 为什么在 bridge 里接线而不是改 index.ts：`LocalDatabase` 由 `AgentRuntimeBridge`
 * 持有（`private readonly localDb`），index.ts 注入的那组回调是闭包、拿不到 DB 句柄。
 * 在这里包一层是唯一不新增全局单例的换法（实施计划的文件映射按「index.ts 可拿到 DB」
 * 写，实际拿不到——差异 #16）。
 *
 * 覆盖的是**四个**写入/读取点：三个 config 回调 + `onConversationEnd`。后者原先不是
 * config 回调（直接写在 index.ts 的 ipc handler 表里），P2-3 只换了前三个，于是每轮
 * 助手回复仍写进旧 Python 宫殿——2026-09-18 实测旧 sqlite 当天 09:54 还在增长，
 * 而检索侧只读自建表，那批内容永远搜不到（差异 #19）。
 */

import { PalaceRepo, type LocalDatabase } from '@mtbot/agent-runtime'
import type { AgentRuntimeBridgeConfig, PalaceSearchHit } from './bridge-types'

/**
 * 每轮助手回复的即时归档落在 `wing='conversations'`、`room=会话 id`。
 *
 * 沿用旧宫殿的坐标，不做"看起来更统一"的重命名：旧 sqlite 里已归档的 234 条用的就是
 * 这组坐标，改名会让同一内容在库里出现两个 drawer_id，而旧内容仍搜不到。检索不按
 * wing 过滤（只按 user_id/agent_id），所以它照样搜得到。
 */
const PER_TURN_WING = 'conversations'

/**
 * 会话归属的 Agent。
 *
 * 三条来源，按可靠性排序（都不是完美的，所以三条都要）：
 *
 * 1. `messages.agent_id` —— 最准，但它**经常为空**：主聊天路径落库时 `saveMessage`
 *    不带该参数，只有 cron 落库 / `send_message` 传话 / 迁移脚本会写。实测默认主会话的
 *    60 条消息里 0 条有值。
 * 2. `conversation_participants` —— 建会话时必写，但存的是**实例 id**（`main`/`default`），
 *    不是宫殿与工作记忆用的**定义 id**（`assistant`/`code-dev`）。照抄会把 178 个主会话
 *    全写成 `main`，而 `memory_search` 按定义 id 过滤 → 全都搜不到，比空值更糟。
 * 3. 兜底 `assistant`（主 Agent 的定义 id）。
 *
 * 所以：先用实例 id → 定义 id 的映射把 participants 归一化，取不到再用 `messages.agent_id`，
 * 最后兜底。定义 id 的映射表来自 AgentRegistry 的语义（`main`/`default` 都是主 Agent）。
 */
const INSTANCE_TO_DEFINITION: Record<string, string> = { main: 'assistant', default: 'assistant' }

function resolveConversationAgentId(localDb: LocalDatabase, conversationId: string): string {
  try {
    // 参与者：实例 id → 定义 id；查不到映射说明它本来就是定义 id（code-dev 等）
    const participant = localDb.db
      .prepare<{ participant_id: string }>(
        `SELECT participant_id FROM conversation_participants
          WHERE conversation_id = ? AND participant_type = 'agent'
          LIMIT 1`,
      )
      .get(conversationId)
    const fromParticipant = participant?.participant_id
    if (fromParticipant) return INSTANCE_TO_DEFINITION[fromParticipant] ?? fromParticipant

    // 没有参与者记录（老会话 / 建会话竞态）时退到消息级归属
    const msg = localDb.db
      .prepare<{ agent_id: string | null }>(
        `SELECT agent_id FROM messages
          WHERE conversation_id = ? AND agent_id IS NOT NULL
          ORDER BY timestamp DESC LIMIT 1`,
      )
      .get(conversationId)
    if (msg?.agent_id) return INSTANCE_TO_DEFINITION[msg.agent_id] ?? msg.agent_id

    return 'assistant'
  } catch {
    return 'assistant'
  }
}

/**
 * 用自建宫殿实现覆盖配置里的四个回调用（其余字段原样透传）。
 *
 * 数据库未打开时返回 undefined / null，让上层走原有的降级路径——**不抛异常**：
 * 记忆宫殿不可用不该让整轮对话失败（沿用 `segment-memory-pipeline` 的 catch 语义）。
 *
 * `onConversationEnd` 是第四个写入点：段归档只覆盖"关闭成段的对话"，而每轮助手回复
 * 落库时也会即时归档一条。它原先写在 index.ts 里直连 Python（不是 config 回调），
 * P2-3 换后端时漏切，导致旧 sqlite 至今仍在增长（2026-09-18 实测 09:54 还有新写入），
 * 那批内容又因为检索只读自建表而永远搜不到。这里一并接管。
 */
export function withBuiltinPalace(
  config: AgentRuntimeBridgeConfig,
  localDb: LocalDatabase,
): AgentRuntimeBridgeConfig {

  /** 每次调用现取句柄：DB 在 initialize 阶段才打开，构造期拿不到 */
  const repo = (): PalaceRepo | null => (localDb.isOpen ? new PalaceRepo(localDb.db) : null)

  return {
    ...config,
    onConversationEnd: (convId: string, assistantText: string) => {
      // 先转发原回调：index.ts 注入的那个还托管着自主进化的轮次结算，
      // 整体替换会把那条旁路一起关掉。
      // 单独 try：宿主回调抛异常不能连累下面的归档——否则本轮回合虽然结束了，
      // 内容却既没进宫殿、记账还降级成调用方的 WARN。
      try {
        config.onConversationEnd?.(convId, assistantText)
      } catch (err) {
        console.error(
          '[Palace] 宿主 onConversationEnd 回调异常:',
          err instanceof Error ? err.message : String(err),
        )
      }

      const text = assistantText.trim()
      const r = repo()
      if (!r || !text || !convId) return
      try {
        const agentId = resolveConversationAgentId(localDb, convId)
        r.upsertDrawer({
          agentId,
          userId: 'local-user',
          wing: PER_TURN_WING,
          room: convId,
          content: text,
          conversationId: convId,
        })
      } catch (err) {
        // 与段归档同一条纪律：内容没进宫殿的记账点必须出现在日志里
        console.error(
          `[Palace] 每轮归档失败 convId=${convId} len=${text.length}:`,
          err instanceof Error ? err.message : String(err),
        )
      }
    },
    searchPalace: async (
      query: string,
      limit?: number,
      scope?: { agentId?: string; userId?: string },
    ): Promise<PalaceSearchHit[] | null> => {
      const r = repo()
      if (!r) return null
      return [
        ...r.searchDrawers({
          query,
          userId: scope?.userId ?? 'local-user',
          // scope.agentId 缺省 = 跨 Agent（宫殿是会话存档，本就跨助手可读）；
          // 与工作记忆通道同一条规则，避免同一 Agent 在注入里看得到、在检索里搜不到
          ...(scope?.agentId ? { agentId: scope.agentId } : {}),
          limit: limit ?? 10,
        }),
      ]
    },
    readPalaceDrawer: async (drawerId: string) => {
      const r = repo()
      if (!r) return null
      return r.readById(drawerId)
    },
    archivePalaceDrawer: async (params) => {
      const r = repo()
      if (!r) return undefined
      const meta = params.metadata ?? {}
      const segmentId = typeof meta.segmentId === 'string' ? meta.segmentId : null
      const conversationId = typeof meta.conversationId === 'string' ? meta.conversationId : null
      const result = r.upsertDrawer({
        agentId: params.agentId ?? 'assistant',
        userId: params.userId ?? 'local-user',
        wing: params.wing,
        room: params.room,
        content: params.content,
        drawerId: params.drawerId,
        conversationId,
        segmentId,
      })
      return { drawerId: result.drawerId }
    },
  }
}
