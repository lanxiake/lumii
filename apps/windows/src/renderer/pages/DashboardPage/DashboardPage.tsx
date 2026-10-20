/**
 * DashboardPage - 概览页
 *
 * 一屏不滚动：页头 + 最近资讯 + 底部三栏「近期关注 / 场景推荐 / 宠物」。
 * 资讯来自「资讯抓取与综述」定时任务写下的 ~/.lumii/news/latest.json。
 *
 * 原本占据首屏的「运行时态势」（CPU/内存/磁盘、技能·MCP 入口、调用节律）已移除——
 * 这些是状态读数，用户平时不关注。用量与花费是事后对账信息，完整面板在设置中心 ›
 * 用量与花费（UsagePanel），不占概览的一屏。
 *
 * 卡片经 slot 渲染（`dashboard.main` 整宽区 / `dashboard.grid` 三栏区）：
 * 内置卡片在 `dashboard-cards.tsx` 注册，插件卡片用同一个 `registerSlot` 追加。
 * 布局仍在这个文件里——slot 只决定「渲染谁、按什么顺序」，不决定「放哪」。
 */

import React from 'react'
import { SlotHost } from '../../components/slots/SlotHost'
import {
  DASHBOARD_GRID_SLOT,
  DASHBOARD_MAIN_SLOT,
  DASHBOARD_PLUGINS_SLOT,
  registerBuiltinDashboardCards,
  type DashboardCardContext,
} from './dashboard-cards'
import type { ViewType } from '../../components/layout/Sidebar/Sidebar'
import styles from './DashboardPage.module.css'

registerBuiltinDashboardCards()

interface DashboardPageProps {
  /** 视图切换回调 */
  onViewChange?: (view: ViewType) => void
}

const DashboardPage: React.FC<DashboardPageProps> = ({ onViewChange }) => {
  const context: DashboardCardContext = { onViewChange }

  return (
    <div className={styles['dashboard-page']}>
      <div className={styles['page-head']}>
        <h1 className={styles['page-title']}>概览</h1>
      </div>

      {/* 最近资讯：点卡片把解读请求预填进对话页 */}
      <SlotHost<DashboardCardContext> name={DASHBOARD_MAIN_SLOT} context={context} />

      {/* 底部：近期关注 + 场景推荐 + 宠物 */}
      <SlotHost<DashboardCardContext>
        name={DASHBOARD_GRID_SLOT}
        context={context}
        // 布局是固定的三栏（1.7fr / 1fr / 216px）且限高，第 4 张会溢出
        max={3}
        wrap={(children) => <div className={styles['bottom-grid']}>{children}</div>}
      />

      {/* 插件专属区：页面为它预留固定高度（最多 168px、内部自滚），
          插件加得再多也不会挤压上面的资讯区与三栏。空的时候整条不渲染。 */}
      <SlotHost<DashboardCardContext>
        name={DASHBOARD_PLUGINS_SLOT}
        context={context}
        wrap={(children) => <div className={styles['plugin-band']}>{children}</div>}
      />
    </div>
  )
}

export { DashboardPage }
