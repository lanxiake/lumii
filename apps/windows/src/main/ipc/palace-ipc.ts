/**
 * 记忆宫殿 IPC（自研实现，替代 MemPalace 插件）
 *
 * 背景（评审 2026-09-17 §4.6）：宫殿原由外部 Python 插件 MemPalace（MCP + chromadb）
 * 承载——本机 chromadb 的 Rust 内核 upsert 直接崩，`palace_drawer_id` 覆盖率实测
 * 4/171 = 2.3%。2026-09-18 换成本地 SQLite（`palace_drawers` + FTS5）后，插件的
 * **安装/卸载/运行时目录**这一整套概念都不存在了：数据就在 `agent-runtime.db` 里，
 * 随应用启动即有。
 *
 * 与 `plugin-ipc.ts` 的关系：那边是 MemPalace 专用的（Python 运行时 + MCP 子进程桥），
 * 本文件是自研实现，两者不共用代码——保留旧文件的唯一理由是删除还没落地，
 * 见 `docs/plans/记忆系统` 的插件移除记录。
 *
 * 三个刻意的选择：
 * 1. **status 不再是"装没装"**：自研没有安装态，`available` 表示"库打开了没有"。
 *    前端据此决定是否显示"后端不可用"，而不是引导去装插件。
 * 2. **search 返回 `score` 而不是 `similarity`**：`-bm25` 是无界相关性分数、不可跨查询
 *    比较；把它包装成 [0,1] 的"相似度"是数据层说谎（与 `PalaceRepo` 同一条纪律）。
 *    展示层要做归一化就在展示层做。
 * 3. **clear 走 `clearAll`（墓碑）而不是逐条硬删**：与 `deleteById` 同一条非破坏纪律——
 *    "清空"在用户心智里是"别再让我搜到"，不是"把对话原文烧了"。
 */

import { ipcMain } from 'electron'
import { PalaceRepo } from '@mtbot/agent-runtime'
import type { AgentRuntimeBridge } from '../agent-runtime/bridge'

interface PalaceIpcLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

const logger: PalaceIpcLogger = {
  info: (...args) => console.log('[Main]', ...args),
  warn: (...args) => console.warn('[Main]', ...args),
  error: (...args) => console.error('[Main]', ...args),
}

/** 当前用户；宫殿与工作记忆同一口径（`conversations.user_id` 全部是它） */
const LOCAL_USER_ID = 'local-user'

/** 宫殿列表/检索的默认作用域上限（UI 一屏 20 条） */
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 200

let _getBridge: (() => AgentRuntimeBridge | null) | null = null

/**
 * 注入 bridge 读取器（与 `setAgentRuntimeBridgeForIpc` 同一模式：主进程启动时装配，
 * 避免本模块直接 import 单例造成循环依赖）。
 */
export function setPalaceBridgeProvider(provider: () => AgentRuntimeBridge | null): void {
  _getBridge = provider
}

/**
 * 取 PalaceRepo。返回 null 表示"宫殿暂不可用"（库没打开 / bridge 没就绪）——
 * 调用方把它转成 `{ available: false }`，**不抛异常**：宫殿坏了不该让设置页白屏。
 */
function repo(): PalaceRepo | null {
  const bridge = _getBridge?.() ?? null
  if (!bridge || !bridge.isInitialized) return null
  try {
    return new PalaceRepo(bridge.db)
  } catch (err) {
    logger.warn('[Palace] 构造 PalaceRepo 失败:', err instanceof Error ? err.message : err)
    return null
  }
}

/**
 * 批量取会话标题：`conversationId → { title, channelType }`。
 *
 * 为什么在 IPC 层而不是 `PalaceRepo` 里 JOIN：`PalaceRepo` 属于 `agent-runtime` 包，
 * 那个包**不知道 `conversations` 表的存在**（它只认识 `palace_drawers`）。让 runtime
 * 去读宿主的会话表会把两层的边界糊掉，而 IPC 层本来就是宿主边界，天然知道这两张表。
 *
 * 一次查一批（`IN (...)`）而不是每条查一次：列表一屏 20 条，逐条查就是 20 次往返。
 */
function loadConversationMeta(
  conversationIds: readonly string[],
): Map<string, { title: string; channelType: string | null }> {
  const out = new Map<string, { title: string; channelType: string | null }>()
  const ids = [...new Set(conversationIds.filter((x): x is string => Boolean(x)))]
  if (ids.length === 0) return out
  const bridge = _getBridge?.() ?? null
  if (!bridge || !bridge.isInitialized) return out
  try {
    const placeholders = ids.map(() => '?').join(',')
    const rows = bridge.db
      .prepare<{ id: string; title: string | null; channel_type: string | null }>(
        `SELECT id, title, channel_type FROM conversations WHERE id IN (${placeholders})`,
      )
      .all(...ids)
    for (const r of rows) {
      out.set(r.id, { title: r.title ?? '', channelType: r.channel_type })
    }
  } catch (err) {
    // 标题只是展示增强：取不到就退回显示原始 id，不该让整个列表失败
    logger.warn('[Palace] 取会话标题失败:', err instanceof Error ? err.message : err)
  }
  return out
}

export function setupPalaceIpcHandlers(): void {
  logger.info('设置记忆宫殿 IPC 处理器（自研 SQLite）')

  /** 状态：可用性 + 条数 + wing 分布。取代旧插件的 installed/runtimeDir */
  ipcMain.handle('palace:status', async () => {
    const r = repo()
    if (!r) return { available: false, counts: null, wings: [] }
    try {
      return {
        available: true,
        counts: r.countByScope(LOCAL_USER_ID),
        wings: r.countByWing(LOCAL_USER_ID),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('[Palace] status 失败:', message)
      return { available: false, counts: null, wings: [], error: message }
    }
  })

  /** 分页列表（按归档时间倒序；列表页只给元数据，正文走 read） */
  ipcMain.handle(
    'palace:list',
    async (
      _event,
      params?: { wing?: string; limit?: number; offset?: number },
    ) => {
      const r = repo()
      if (!r) return { available: false, items: [], total: 0 }
      try {
        const result = r.listDrawers({
          userId: LOCAL_USER_ID,
          limit: Math.min(params?.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
          offset: params?.offset ?? 0,
          ...(params?.wing ? { wing: params.wing } : {}),
        })
        // 附带会话标题：列表页显示「飞书 · 帮我解读这条内容」比「feishu:ou_ba9a…」可读
        const meta = loadConversationMeta(
          result.items.map((it) => it.conversation_id).filter((x): x is string => Boolean(x)),
        )
        const items = result.items.map((it) => ({
          ...it,
          ...(it.conversation_id ? { conversationTitle: meta.get(it.conversation_id)?.title ?? '' } : {}),
          ...(it.conversation_id ? { channelType: meta.get(it.conversation_id)?.channelType ?? null } : {}),
        }))
        return { available: true, items, total: result.total }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error('[Palace] list 失败:', message)
        return { available: false, items: [], total: 0, error: message }
      }
    },
  )

  /** 检索（返回摘录 + score=-bm25；全文走 read） */
  ipcMain.handle(
    'palace:search',
    async (_event, params: { query: string; limit?: number; wing?: string }) => {
      const r = repo()
      if (!r) return { available: false, results: [] }
      try {
        const results = r.searchDrawers({
          query: params.query,
          userId: LOCAL_USER_ID,
          limit: Math.min(params.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
          ...(params.wing ? { wing: params.wing } : {}),
        })
        // 命中项只带 wing/room，没有 conversationId——room 在「每轮归档」坐标下就是会话 id，
        // 但段归档坐标下是日期。两种都拿去查一次，查得到的才附标题。
        const meta = loadConversationMeta(results.map((it) => it.room))
        const enriched = results.map((it) => ({
          ...it,
          ...(meta.has(it.room)
            ? {
                conversationTitle: meta.get(it.room)?.title ?? '',
                channelType: meta.get(it.room)?.channelType ?? null,
              }
            : {}),
        }))
        return { available: true, results: enriched }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        logger.error('[Palace] search 失败:', message)
        return { available: false, results: [], error: message }
      }
    },
  )

  /** 按 id 读全文（列表/检索命中后点开详情） */
  ipcMain.handle('palace:read', async (_event, drawerId: string) => {
    const r = repo()
    if (!r) return { available: false, detail: null }
    try {
      return { available: true, detail: r.readById(drawerId) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('[Palace] read 失败:', message)
      return { available: false, detail: null, error: message }
    }
  })

  /** 删除单条（写墓碑，非破坏） */
  ipcMain.handle('palace:delete', async (_event, drawerId: string) => {
    const r = repo()
    if (!r) return { success: false, error: 'unavailable' }
    try {
      const ok = r.deleteById(drawerId)
      return { success: ok }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('[Palace] delete 失败:', message)
      return { success: false, error: message }
    }
  })

  /** 清空全部（墓碑，非破坏）。取代旧插件「逐条 list+delete 循环」的做法 */
  ipcMain.handle('palace:clear', async () => {
    const r = repo()
    if (!r) return { success: false, deleted: 0, error: 'unavailable' }
    try {
      const { cleared } = r.clearAll(LOCAL_USER_ID)
      logger.info(`[Palace] 已清空 ${cleared} 条归档（墓碑）`)
      return { success: true, deleted: cleared }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('[Palace] clear 失败:', message)
      return { success: false, deleted: 0, error: message }
    }
  })
}
