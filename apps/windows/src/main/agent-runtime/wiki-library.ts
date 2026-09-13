/**
 * 共享资料库（Wiki）归属键。
 *
 * 2026-09-13 拍板：Wiki 是用户的长期资产，全队（主助手 + 各专项 Agent）读写同一个库
 * （「维护官策展、全员检索」）。库 owner 沿用历史值 'assistant'——存量数据、UI 与
 * IPC 默认视图（wiki-commands.ts 兜底）都以它为键，改键会分裂数据。
 *
 * agent_id 列保留为库归属与录入来源数据，但不再用于按 Agent 隔离查询。
 */
export const SHARED_WIKI_LIBRARY_AGENT_ID = 'assistant'
