import type { UsageQuery, UsageSummary } from './store'
import type { ModelPriceInput } from '../../../shared/model-pricing'

/**
 * 用量统计对核心暴露的**读**能力（写是插件自己的事：订阅 `llm:after-response`）。
 *
 * `usage:query` 是控制面/设置页的查询入口；插件停用后查不到服务，
 * 接口如实返回错误而不是给一份空数据（空数据会被误读成「这个月没调用」）。
 *
 * 价格读写也挂在这里：自定义价只影响「怎么算」，不产生记录，
 * 放同一个服务省一条 IPC 通道，也让「插件停用 = 价格也不生效」这条语义自洽。
 */
export interface UsageService {
  query(query: UsageQuery): Promise<UsageSummary>
  /** 当前生效的自定义价（前缀 → 价格） */
  getPrices(): Record<string, ModelPriceInput>
  /** 整表替换自定义价，返回落盘后的那份 */
  setPrices(prices: Record<string, ModelPriceInput>): Record<string, ModelPriceInput>
  /** 把某个前缀恢复成内置价（不传前缀 = 全部恢复）。返回恢复后的整表 */
  syncPrices(prefix?: string): Record<string, ModelPriceInput>
}
