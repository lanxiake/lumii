import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../kernel/events'

/**
 * 首页信息流扩展。
 *
 * ## 架构定位
 *
 * 内建插件,可禁用。禁用后:
 * - 信息流数据不再记录（`dashboard_feed_*` 工具不可用）
 * - 首页信息流卡片无数据
 * - Cron 资讯任务仍会运行,但写入路径失效
 *
 * ## 依赖与时序
 *
 * - **Agent Runtime (Bridge)**: 数据库注入时机（`setDashboardFeedDb(db)` 在 bridge.ts L858）
 * - **工具注册**: `dashboard_*` 系列工具在 `bridge-tool-registrar.ts` 注册
 * - **激活时机**: bridge 初始化后（S7 阶段,主数据库打开时注入）
 *
 * ## 核心逻辑
 *
 * 1. **存储协议** (`dashboard-feed-store.ts`):
 *    - SQLite 表: `dashboard_feed_meta` / `dashboard_feed_items`（schema V35）
 *    - 每个 feed 最多 1000 条,支持游标分页
 *    - 模块级 db 注入:由 bridge 调用 `setDashboardFeedDb(db)` 注入
 *
 * 2. **数据流**:
 *    - Agent 工具 → `writeDashboardFeedSnapshot` → SQLite 表
 *    - 渲染层首页组件 → `readDashboardFeed*` API → 读取数据
 *    - Cron 资讯任务 → 写入 feed → 版本号 +1（用于判断任务是否产生数据）
 *
 * 3. **工具清单**:
 *    - `dashboard_read_feed`: 读取 feed 数据（分页）
 *    - `dashboard_write_feed`: 写入 feed 数据（Agent 推送）
 *    - `dashboard_list_feeds`: 列出所有 feed
 *
 * 4. **渲染层集成**:
 *    - 首页信息流卡片: `renderer/pages/Dashboard/DashboardFeed.tsx`
 *    - 数据服务: `renderer/services/dashboard-feed-service.ts`
 *
 * ## P1 vs P2
 *
 * - P1: 包装成插件,支持禁用/启用,核心逻辑不动（数据库注入在 bridge.ts L858,
 *   工具注册在 `bridge-tool-registrar.ts`）
 * - P2: 工具注册迁移到插件内（`ctx.registerTool(...)`),数据库注入改为插件
 *   提供服务（`ctx.provide(DASHBOARD_FEED_SERVICE)`）,渲染层做容错（插件禁用时不显示卡片）
 *
 * ## 为什么 P1 不做热插拔
 *
 * 信息流存储的数据库注入在 bridge 初始化期:
 * 1. `setDashboardFeedDb(db)` 在 bridge.ts L858 调用（主数据库打开后）
 * 2. 工具注册在 `bridge-tool-registrar.ts` 静态注册（L2096-2139）
 * 3. 渲染层首页组件在启动时加载,无条件读取 feed 数据
 *
 * 要做真正的热插拔需要:
 * 1. 将数据库注入从 bridge 移到插件 `apply(ctx)`
 * 2. 将工具注册从 tool-registrar 移到插件内
 * 3. 渲染层首页组件做容错（插件禁用时隐藏信息流卡片）
 * 4. 支持运行时注销工具（目前工具注册无对应的 `unregister` API）
 *
 * P1 先做声明式包装,P2 再做执行期迁移。
 */
export const dashboardFeedExtension = {
  manifest: {
    id: 'com.lumii.dashboard-feed',
    name: '首页信息流',
    version: '0.1.0',
    description: '首页资讯/工作日报/自定义信息流的存储与展示',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.dashboard-feed',
    provides: ['dashboard-feed'],
    apply(ctx) {
      // 信息流存储实际初始化在 `bridge.ts` L858（setDashboardFeedDb(db)）,
      // 工具注册在 `bridge-tool-registrar.ts`。本插件作为"声明式开关"存在:
      // - 启用时: 数据库正常注入,工具正常注册
      // - 禁用时: P2 改造后在此处跳过数据库注入与工具注册
      //
      // P1 阶段禁用插件 = 代码不加载,但 bridge 照旧执行,数据库照旧注入——
      // 所以 P1 禁用插件**不影响**首页信息流功能。
      //
      // 为什么不在这里注入数据库:
      // 1. 数据库注入时机在 bridge 初始化期（主数据库打开后）
      // 2. 工具注册在 bridge-tool-registrar 静态注册
      // 3. 渲染层首页组件在启动时加载,无条件读取 feed 数据
      //
      // P1 目标: 包装 + 文档完善,不改行为; P2 才做真正的按需激活与热插拔。

      ctx.log.info('首页信息流插件已加载（数据库注入由 bridge 完成）')

      // P2: 禁用时停止数据库注入与工具注册
      // ctx.effect(() => {
      //   setDashboardFeedDb(null) // 清除数据库注入
      //   unregisterTools(['dashboard_read_feed', 'dashboard_write_feed', 'dashboard_list_feeds'])
      //   ctx.log.info('首页信息流插件卸载,已清除数据库注入')
      // })
    },
  }),
}
