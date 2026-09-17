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
 * 用自建宫殿实现覆盖配置里的三个回调用（其余字段原样透传）。
 *
 * 数据库未打开时返回 undefined / null，让上层走原有的降级路径——**不抛异常**：
 * 记忆宫殿不可用不该让整轮对话失败（沿用 `segment-memory-pipeline` 的 catch 语义）。
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
