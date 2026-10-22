import type { UsageQuery, UsageSummary } from './store'

/**
 * 用量统计对核心暴露的**读**能力（写是插件自己的事：订阅 `llm:after-response`）。
 *
 * `usage:query` 是控制面/设置页的查询入口；插件停用后查不到服务，
 * 接口如实返回错误而不是给一份空数据（空数据会被误读成「这个月没调用」）。
 */
export interface UsageService {
  query(query: UsageQuery): Promise<UsageSummary>
}
