/**
 * 概览信息流的共享常量。
 *
 * 放在 shared 是因为**核心与插件都要用**：cron 写资讯、API 读分页、插件存储默认 id。
 * 常量留在插件里会让核心为了一个字符串去 import 插件实现（守卫 ⑪ 的边界就漏了）。
 */

/** 默认 feed id（新闻） */
export const DEFAULT_DASHBOARD_FEED_ID = 'news'

/** 每个 feed 最多保留的条目数（概览页滑动分页上限） */
export const MAX_FEED_ITEMS = 1000
