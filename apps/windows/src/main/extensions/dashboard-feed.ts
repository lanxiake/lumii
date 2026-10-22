import { definePlugin } from '@mtbot/plugin-core'
import {
  createMtBotTool,
  type MtBotToolConfig,
  dashboardFeedWriteToolConfig,
  dashboardFeedReadToolConfig,
} from '@mtbot/agent-runtime'

import type { MainEvents } from '../kernel/events'
import { agentRuntimeLog as log, jsonToolResult } from '../agent-runtime/bridge-utils'
import {
  writeDashboardFeedSnapshot,
  readDashboardFeedPage,
  countDashboardFeedItems,
  DEFAULT_DASHBOARD_FEED_ID,
  uniqueDashboardFeedItemId,
} from '../dashboard-feed-store'
import type { BridgeToolRegistrarDeps } from '../agent-runtime/bridge-tool-registrar-types'

/**
 * 首页信息流扩展。
 *
 * ## 架构定位
 *
 * 内建插件，可禁用。禁用后：
 * - 信息流工具不可用（`dashboard_feed_write` / `dashboard_feed_read`）
 * - 首页信息流卡片无数据（渲染层需做容错）
 * - Cron 资讯任务写入失败（工具不存在）
 *
 * ## 依赖与时序
 *
 * - **Agent Runtime 工具注册**：插件启动时注册工具（P2，已从 `bridge-tool-registrar.ts` 迁移）
 * - **数据库注入**：仍由 bridge 在初始化期完成（`setDashboardFeedDb(db)` 在 bridge.ts L858）
 * - **激活时机**：插件注册时立即注册工具（懒订阅，不阻塞启动）
 *
 * ## 核心逻辑
 *
 * 1. **存储协议**（`dashboard-feed-store.ts`）：
 *    - SQLite 表：`dashboard_feed_meta` / `dashboard_feed_items`（schema V35）
 *    - 每个 feed 最多 1000 条，支持游标分页
 *    - 模块级 db 注入：由 bridge 调用 `setDashboardFeedDb(db)` 注入（未来可迁移到插件）
 *
 * 2. **数据流**：
 *    - Agent 工具 → `writeDashboardFeedSnapshot` → SQLite 表
 *    - 渲染层首页组件 → `readDashboardFeed*` API → 读取数据
 *    - Cron 资讯任务 → 调用工具 → 版本号 +1
 *
 * 3. **工具清单**：
 *    - `dashboard_feed_write`：写入 feed 数据（Agent 推送资讯）
 *    - `dashboard_feed_read`：读取 feed 数据（分页）
 *
 * 4. **渲染层集成**：
 *    - 首页信息流卡片：`renderer/pages/Dashboard/DashboardFeed.tsx`
 *    - 数据服务：`renderer/services/dashboard-feed-service.ts`
 *
 * ## P1 vs P2
 *
 * - **P1**（包装式）：只声明插件，工具注册仍在 `bridge-tool-registrar.ts`，禁用不影响功能
 * - **P2**（工具迁移式，当前实现）：工具注册逻辑迁移到插件内，调用点用
 *   `isExtensionActive('com.lumii.dashboard-feed')` 决定接不接线
 *   - 禁用插件 = 工具**根本不进注册表**（`tools:list` 里看不到），不是「还在但报错」
 * - **P3**（未做）：数据库注入仍在 `bridge.ts`（`setDashboardFeedDb`）
 *
 * ## 为什么 schema 不在 `ALL_BUILT_IN_TOOL_CONFIGS` 里
 *
 * 那两个 config 只有 stub（`execute` 返回 `not_implemented`），真实现是本文件的覆盖注册。
 * 留在总表里的话，插件被禁用后工具仍会出现在 Agent 的工具表里，模型白白调用一次再拿到
 * `not_implemented`。所以总表里删掉了它们，schema 仍从 `@mtbot/agent-runtime` 导出复用。
 * （实测：禁用后 `tools:list` 160 项、无 feed 工具；启用后 162 项、两个都在。）
 *
 * ## 迁移检查清单
 *
 * - [x] 创建插件文件（`extensions/dashboard-feed.ts`）
 * - [x] 将 `registerDashboardFeedTool` 逻辑迁移到插件导出函数
 * - [x] 复用 `dashboard-feed-store.ts` 的存储函数
 * - [x] 调用点接入插件状态门（`bridge-tool-registrar.ts` L61）
 * - [x] 端到端验证（2026-10-22）：禁用后重启，`tools:list` 160 项、无 feed 工具；
 *       恢复后 162 项、两个都在
 * - [ ] P3: 数据库注入迁移到插件（目前仍在 bridge.ts）
 */
export const dashboardFeedExtension = {
  manifest: {
    id: 'com.lumii.dashboard-feed',
    name: '首页信息流',
    version: '0.2.0',
    description: '首页资讯/工作日报/自定义信息流的存储与展示',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.dashboard-feed',
    provides: ['dashboard-feed'],
    apply(ctx) {
      ctx.log.info('首页信息流插件已启动')
    },
  }),
}

/**
 * 注册首页信息流工具（从 bridge-tool-registrar-cron.ts 迁移）。
 *
 * 由 BridgeToolRegistrar.registerAll() 调用，时序在插件 apply() 之后、
 * AgentRuntime 初始化完成后。
 */
export function registerDashboardFeedTools(deps: BridgeToolRegistrarDeps): void {
  const ctx = deps.toolContext
  if (!ctx) return

  // dashboard_feed_write 工具
  const dashboardFeedWrite: MtBotToolConfig = {
    ...dashboardFeedWriteToolConfig,
    execute: async (_id, rawParams) => {
      const p = rawParams as {
        title: string
        summary?: string
        items: Array<{ title: string; summary?: string; href?: string; source?: string }>
      }
      if (!p.title?.trim()) {
        return jsonToolResult({ status: 'error', message: 'title is required' })
      }
      if (!Array.isArray(p.items) || p.items.length === 0) {
        return jsonToolResult({ status: 'error', message: 'items must be a non-empty array' })
      }
      try {
        const executorId = deps.getCurrentToolExecutorInstanceId?.()
        const convId = executorId ? deps.instanceToConversation?.get(executorId) : undefined
        await writeDashboardFeedSnapshot({
          feedId: DEFAULT_DASHBOARD_FEED_ID,
          title: p.title.trim(),
          updatedAt: Date.now(),
          ...(p.summary?.trim() ? { summary: p.summary.trim() } : {}),
          batch: { source: 'agent', ...(convId ? { conversationId: convId } : {}) },
          items: (() => {
            const seenIds = new Map<string, number>()
            return p.items.map((item, index) => ({
              id: uniqueDashboardFeedItemId(
                { href: item.href?.trim(), title: item.title },
                index,
                seenIds,
              ),
              title: item.title,
              ...(item.summary ? { summary: item.summary } : {}),
              ...(item.href ? { href: item.href } : {}),
              ...(item.source ? { source: item.source } : {}),
              timestamp: Date.now(),
              kind: 'news',
            }))
          })(),
        })
        return jsonToolResult({ status: 'ok', itemCount: p.items.length })
      } catch (err) {
        return jsonToolResult({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
  deps.toolRegistry.register(createMtBotTool(dashboardFeedWrite, ctx))
  log.info('[dashboard-feed] dashboard_feed_write registered')

  // dashboard_feed_read 工具
  const dashboardFeedRead: MtBotToolConfig = {
    ...dashboardFeedReadToolConfig,
    execute: async (_id, rawParams) => {
      const p = rawParams as { limit?: number }
      const requested = Number.isFinite(p.limit) ? Number(p.limit) : 30
      const limit = Math.max(1, Math.min(100, Math.trunc(requested)))
      try {
        const page = await readDashboardFeedPage(DEFAULT_DASHBOARD_FEED_ID, { limit })
        return jsonToolResult({
          status: 'ok',
          feedId: DEFAULT_DASHBOARD_FEED_ID,
          count: page.items.length,
          totalCount: countDashboardFeedItems(DEFAULT_DASHBOARD_FEED_ID),
          hasMore: page.nextCursor !== null,
          items: page.items.map((item) => ({
            title: item.title,
            ...(item.summary ? { summary: item.summary } : {}),
            ...(item.source ? { source: item.source } : {}),
            ...(item.href ? { href: item.href } : {}),
            ...(typeof item.timestamp === 'number'
              ? { timestamp: new Date(item.timestamp).toISOString() }
              : {}),
            ...(item.kind ? { kind: item.kind } : {}),
          })),
        })
      } catch (err) {
        return jsonToolResult({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
  deps.toolRegistry.register(createMtBotTool(dashboardFeedRead, ctx))
  log.info('[dashboard-feed] dashboard_feed_read registered')
}
