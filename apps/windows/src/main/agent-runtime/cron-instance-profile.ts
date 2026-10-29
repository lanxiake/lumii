/**
 * 定时任务实例的「瘦身档」：限轮数 + 摘掉整组无关工具。
 *
 * ---------------------------------------------------------------------------
 * 为什么要有这一档
 * ---------------------------------------------------------------------------
 * 实测（2026-10-27~29 日志 `llm:after-response`，conversationId 以 `cron:` 开头）：
 *   - 604 次 cron 模型调用，累计 1459 万 input tokens，**cacheRead 恒为 0**
 *   - 39 次运行，每次 5~41 轮模型往返（assistant 定义里 maxTurns=80）
 *   - 单次运行内 input 单调增长：106k → 146k → 160k → 168k → 173k
 *
 * 也就是说，一次定时任务被跑成了一场长工具循环，每轮把累积上下文重发一遍，
 * 而且没有缓存可依赖（中继端点 `cacheRead` 全是 0）。
 *
 * 上下文构成（同源日志 `contextUsage breakdown`）：
 *   tools 12.5k / mcp 1.9k / systemPrompt 1.2k / conversation 最高 160k
 *
 * 所以两个乘数都收：**轮数**（长尾直接砍掉）与**工具面**（每轮固定开销）。
 * 工具面用「摘整组」而不是「白名单」——实测语料里 A股盯盘用 `bash` 取墙钟、
 * 小红书巡检用 `mcp-trends-hub`，白名单会把它们当场弄坏；摘组只删确定无关的。
 */

/** 定时任务的轮数上限（assistant 默认 80，实测中位数 17、长尾 41） */
export const CRON_MAX_TURNS = 12

/**
 * 定时任务**用不到**的整组工具（名字取自 `prompt/sections/tooling-section.ts` 的分组表）。
 *
 * - 媒体生成：贵且与例行任务无关
 * - 委派：cron 实例不该再派生 Agent（`canSpawnSubAgents:false` 已挡 spawn/send，这里补齐 handoff）
 * - 团队管理 / 自我配置 / 浏览器 / 会话切换 / 引导：都不是例行任务该干的事
 * - `ask_user_question`：**无人值守**的任务问人只会挂到超时，摘掉是安全约束不是省钱
 * - 云同步：只有 system-maintenance 用
 *
 * 刻意**保留**：文件、Shell、Web、任务、调度、技能、记忆/知识、消息、看板、资讯偏好、
 * 本机微信、以及全部 `mcp__*`（按端点动态注册，静态表列不全，误摘会静默弄坏任务）。
 */
export const CRON_DISALLOWED_TOOLS: readonly string[] = [
  // 媒体生成
  'image_generate',
  'speech_generate',
  // 委派与团队
  'spawn_agent',
  'send_message',
  'propose_dev_handoff',
  'agent_team_generate',
  'agent_team_optimize',
  'agent_remove',
  // 自我配置
  'profile_memory',
  'system_prompt',
  'plugin_dev',
  // 无人值守不能问人
  'ask_user_question',
  // 浏览器
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_wait',
  'browser_eval',
  'browser_back',
  'browser_forward',
  'browser_screenshot',
  // 会话与设置
  'session_create',
  'session_clear',
  'session_compact',
  'session_resume',
  'session_list',
  'session_rename',
  'settings_think',
  'settings_backend',
  'info_status',
  // 引导
  'a2ui_guide',
  'cron_guide',
  'weixin_send_guide',
  'prompt_guide',
  // 云同步（system-maintenance 专用；cron 目标走的是 autonomous_goals，不是这里）
  'cloud_sync_read_file',
  'cloud_sync_git',
  'cloud_sync_now',
  'cloud_sync_push',
  'resolve_sync_conflict',
]

/**
 * 把 Agent 定义收窄成定时任务档。
 *
 * **只做减法**，不覆盖模型/人格/系统提示——那也是任务该有的东西。`maxTurns` 取
 * 「定义里的值」与上限的较小者：某个 Agent 自己已经设了更严的轮数就不放宽它。
 */
export function narrowDefinitionForCron<T extends {
  maxTurns?: number
  canSpawnSubAgents?: boolean
  disallowedTools?: readonly string[]
}>(def: T): T & { maxTurns: number; canSpawnSubAgents: false; disallowedTools: string[] } {
  return {
    ...def,
    maxTurns: Math.min(def.maxTurns ?? CRON_MAX_TURNS, CRON_MAX_TURNS),
    canSpawnSubAgents: false,
    disallowedTools: Array.from(new Set([...(def.disallowedTools ?? []), ...CRON_DISALLOWED_TOOLS])),
  }
}
