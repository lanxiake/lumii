/**
 * 记忆宫殿后端选择：自建 SQLite（默认） / 旧 MemPalace（Python，逃生开关）
 *
 * 动因（评审 2026-09-17 §4.6 / 自建记忆宫殿实施计划 T5）：宫殿原由 MemPalace
 * （Python MCP + chromadb）承载——本机 chromadb 的 Rust 内核 upsert 直接 0xC0000005 崩溃，
 * 且 `palace_drawer_id` 覆盖率实测只有 4/171 = 2.3%。换句话说，「过去说过什么」这条
 * 召回路径**实际上从来不存在**，降级路径是「grep 两个 Markdown 文件」。
 *
 * 为什么在 bridge 里换实现而不是改 index.ts：`LocalDatabase` 由 `AgentRuntimeBridge`
 * 持有（`private readonly localDb`），index.ts 注入的那组回调是闭包、拿不到 DB 句柄。
 * 在这里包一层是唯一不新增全局单例的换法（实施计划的文件映射按「index.ts 可拿到 DB」
 * 写，实际拿不到——差异 #16）。
 *
 * 覆盖的是**四个**写入/读取点：三个 config 回调 + `onConversationEnd`。后者原先不是
 * config 回调（直接写在 index.ts 的 ipc handler 表里），P2-3 只换了前三个，于是每轮
 * 助手回复仍写进旧 Python 宫殿——2026-09-18 实测旧 sqlite 当天 09:54 还在增长，
 * 而检索侧只读自建表，那批内容永远搜不到（差异 #19）。
 *
 * 为什么保留 MemPalace 分支：`agent_memories.palace_drawer_id` 已有 4 条指向 Python 侧
 * drawer_id 的死链，回退只保证「新段仍有地方去」，不保证旧 id 可读（R4）。
 * 一个版本周期后连同 `mempalace-mcp-client.ts` 一起删。
 */

import { PalaceRepo, type LocalDatabase } from '@mtbot/agent-runtime'
import type { AgentRuntimeBridgeConfig, PalaceSearchHit } from './bridge-types'

export type PalaceBackend = 'builtin' | 'mempalace'

/** 默认自建。只有显式写 `LUMII_PALACE_BACKEND=mempalace` 才回到 Python 后端 */
export function resolvePalaceBackend(env: NodeJS.ProcessEnv = process.env): PalaceBackend {
  return (env.LUMII_PALACE_BACKEND ?? '').trim().toLowerCase() === 'mempalace'
    ? 'mempalace'
    : 'builtin'
}

/**
 * 每轮助手回复的即时归档落在 `wing='conversations'`、`room=会话 id`。
 *
 * 沿用旧宫殿的坐标，不做"看起来更统一"的重命名：旧 sqlite 里已归档的 234 条用的就是
 * 这组坐标，改名会让同一内容在库里出现两个 drawer_id，而旧内容仍搜不到。检索不按
 * wing 过滤（只按 user_id/agent_id），所以它照样搜得到。
 */
const PER_TURN_WING = 'conversations'

/** 会话归属的 Agent：取该会话最后一条带 agent_id 的助手消息；查不到按主 Agent 兜底 */
function resolveConversationAgentId(localDb: LocalDatabase, conversationId: string): string {
  try {
    const row = localDb.db
      .prepare<{ agent_id: string | null }>(
        `SELECT agent_id FROM messages
          WHERE conversation_id = ? AND agent_id IS NOT NULL
          ORDER BY timestamp DESC LIMIT 1`,
      )
      .get(conversationId)
    return row?.agent_id ?? 'assistant'
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
 * 那批内容又因为检索只读 builtin 而永远搜不到。这里一并接管。
 */
export function withBuiltinPalace(
  config: AgentRuntimeBridgeConfig,
  localDb: LocalDatabase,
  backend: PalaceBackend = resolvePalaceBackend(),
): AgentRuntimeBridgeConfig {
  if (backend !== 'builtin') return config

  /** 每次调用现取句柄：DB 在 initialize 阶段才打开，构造期拿不到 */
  const repo = (): PalaceRepo | null => (localDb.isOpen ? new PalaceRepo(localDb.db) : null)

  return {
    ...config,
    onConversationEnd: (convId: string, assistantText: string) => {
      // 先转发原回调：index.ts 注入的那个还托管着自主进化的轮次结算，
      // 整体替换会把那条旁路一起关掉
      config.onConversationEnd?.(convId, assistantText)

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
