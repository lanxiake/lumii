import { registerSlot } from '../../components/slots/slot-registry'
import type { ViewType } from '../../components/layout/Sidebar/Sidebar'
import { NewsFeed } from './components/NewsFeed'
import { RecentFocus } from './components/RecentFocus'
import { ScenarioSuggest } from './components/ScenarioSuggest'
import { VirtualHuman } from './components/VirtualHuman'

/**
 * 概览页的卡片注册。
 *
 * 两个 slot 而不是一个：页面顶部是**整宽**资讯，底部是**三栏网格**——
 * 布局属于页面，不属于卡片。硬塞进一个 slot 就等于把布局决策搬进注册表。
 */

/** 顶部整宽区 */
export const DASHBOARD_MAIN_SLOT = 'dashboard.main'
/** 底部三栏区 */
export const DASHBOARD_GRID_SLOT = 'dashboard.grid'
/** 插件专属区：页面为它预留了固定高度预算，插件加多少都不会挤压上面的布局 */
export const DASHBOARD_PLUGINS_SLOT = 'dashboard.plugins'

export interface DashboardCardContext {
  onViewChange?: (view: ViewType) => void
}

let registered = false

/**
 * 注册内置卡片（幂等）。
 *
 * 在模块加载时调用一次：内置卡片与页面同生命周期，不需要注销。
 * 插件卡片走同一套 `registerSlot`，只是 owner 不同、且带注销函数。
 */
export function registerBuiltinDashboardCards(): void {
  if (registered) return
  registered = true

  registerSlot<DashboardCardContext>(DASHBOARD_MAIN_SLOT, {
    id: 'builtin.news-feed',
    component: NewsFeed,
    order: 10,
    owner: 'builtin',
  })
  registerSlot<DashboardCardContext>(DASHBOARD_GRID_SLOT, {
    id: 'builtin.recent-focus',
    component: RecentFocus,
    order: 10,
    owner: 'builtin',
  })
  registerSlot<DashboardCardContext>(DASHBOARD_GRID_SLOT, {
    id: 'builtin.scenario-suggest',
    component: ScenarioSuggest,
    order: 20,
    owner: 'builtin',
  })
  registerSlot<DashboardCardContext>(DASHBOARD_GRID_SLOT, {
    id: 'builtin.virtual-human',
    component: VirtualHuman,
    order: 30,
    owner: 'builtin',
  })
}
