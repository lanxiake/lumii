import { defineServiceAccessor } from '../../plugins/api'
import type { DashboardFeedService } from '../../plugins/builtin/dashboard-feed/service-api'

/**
 * 概览信息流的核心侧入口。
 *
 * 消费方：cron 调度器/归档、新闻命令、控制面 API、bridge（注入 db 与注册工具）。
 * 插件停用 → 服务消失 → 这些路径静默跳过；资讯卡保持空态，工具不注册。
 */
const accessor = defineServiceAccessor<DashboardFeedService>('dashboardFeed')

export function setDashboardFeedAccessor(
  fn: (() => DashboardFeedService | null) | null,
): void {
  accessor.setResolver(fn)
}

export function getDashboardFeedService(): DashboardFeedService | null {
  return accessor.get()
}
