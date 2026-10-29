/**
 * 定时任务瘦身档的三条硬约束：
 *   1. 轮数只降不升（Agent 自己设得更严就照它的）；
 *   2. 摘掉的是**确定无关**的整组工具，语料里真在用的（bash / web_fetch / MCP）一个都不能少；
 *   3. `ask_user_question` 必须摘——无人值守的任务问人只会挂到超时。
 */
import { describe, expect, it } from 'vitest'
import {
  CRON_DISALLOWED_TOOLS,
  CRON_MAX_TURNS,
  narrowDefinitionForCron,
} from './cron-instance-profile'

describe('narrowDefinitionForCron', () => {
  it('没设 maxTurns 的（assistant 默认 80 在上游）收到上限', () => {
    expect(narrowDefinitionForCron({}).maxTurns).toBe(CRON_MAX_TURNS)
    expect(narrowDefinitionForCron({ maxTurns: 80 }).maxTurns).toBe(CRON_MAX_TURNS)
  })

  it('Agent 自己设得更严时不放宽', () => {
    expect(narrowDefinitionForCron({ maxTurns: 5 }).maxTurns).toBe(5)
  })

  it('关掉委派，并合并已有黑名单（去重）', () => {
    const out = narrowDefinitionForCron({ disallowedTools: ['image_generate', 'custom_x'] })
    expect(out.canSpawnSubAgents).toBe(false)
    expect(out.disallowedTools).toContain('custom_x')
    expect(out.disallowedTools.filter((t) => t === 'image_generate')).toHaveLength(1)
  })

  it('摘掉无人值守不能用的 ask_user_question', () => {
    expect(CRON_DISALLOWED_TOOLS).toContain('ask_user_question')
  })

  it('语料里真在用的工具一个都不能摘（白名单化会当场弄坏任务）', () => {
    // A股盯盘「第一步 取墙钟：bash date」、资讯抓取 web_search/web_fetch + dashboard_feed_write、
    // 小红书巡检走 mcp-trends-hub（mcp__* 不在静态表里，只能靠「不摘」保住）
    for (const tool of ['bash', 'web_search', 'web_fetch', 'dashboard_feed_write', 'file_read']) {
      expect(CRON_DISALLOWED_TOOLS).not.toContain(tool)
    }
  })
})
