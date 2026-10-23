import { getSlotEntries, registerSlot, type SlotEntry } from '../../components/slots/slot-registry'
import type { ViewType } from '../../components/layout/Sidebar/Sidebar'
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

/**
 * 注册内置卡片（真幂等）。
 *
 * **不能只用一个模块级 `registered` 布尔**：Vite HMR 会重新执行本模块，
 * 标志被重置，而 slot-registry 里的旧条目还在 → `registerSlot` 抛「已存在 id」，
 * 表现为「改这一行就整页白屏」。
 * 所以按**注册表里的实际状态**判重，而不是靠本模块的变量。
 */
export function registerBuiltinDashboardCards(): void {
  const ensure = <P,>(slot: string, entry: SlotEntry<P>): void => {
    if (getSlotEntries(slot).some((e) => e.id === entry.id)) return
    registerSlot(slot, entry)
  }

  // 资讯卡（dashboard.main）由 com.lumii.dashboard-feed 插件在 setup 里注册
  ensure(DASHBOARD_GRID_SLOT, {
    id: 'builtin.recent-focus',
    component: RecentFocus,
    order: 10,
    owner: 'builtin',
  } satisfies SlotEntry<DashboardCardContext>)
  ensure(DASHBOARD_GRID_SLOT, {
    id: 'builtin.scenario-suggest',
    component: ScenarioSuggest,
    order: 20,
    owner: 'builtin',
  } satisfies SlotEntry<DashboardCardContext>)
  ensure(DASHBOARD_GRID_SLOT, {
    id: 'builtin.virtual-human',
    component: VirtualHuman,
    order: 30,
    owner: 'builtin',
  } satisfies SlotEntry<DashboardCardContext>)
}
