import { describe, expect, it } from 'vitest'
import {
  buildSelfBriefing,
  formatElapsed,
  LAST_OUTPUT_MAX_CHARS,
} from './self-briefing'

/** 固定"现在"：2026-09-16 14:00 本地 */
const NOW = new Date('2026-09-16T14:00:00').getTime()
const hoursAgo = (h: number) => NOW - h * 3600_000

describe('formatElapsed', () => {
  it('分档给相对时间', () => {
    expect(formatElapsed(NOW - 30_000, NOW)).toBe('刚刚')
    expect(formatElapsed(NOW - 5 * 60_000, NOW)).toBe('5 分钟前')
    expect(formatElapsed(NOW - 14 * 3600_000, NOW)).toBe('14 小时前')
    expect(formatElapsed(NOW - 50 * 3600_000, NOW)).toBe('2 天前')
  })

  it('时钟回拨（now 早于 from）不产生负数', () => {
    expect(formatElapsed(NOW + 3600_000, NOW)).toBe('刚刚')
  })
})

describe('buildSelfBriefing', () => {
  it('首次执行什么都不注入，而不是给一个空的「你上次…」块', () => {
    // 空块会让模型以为上轮出了什么问题——没有就是没有
    expect(buildSelfBriefing({ lastOutput: null, lastOutputAt: null, now: NOW })).toBe('')
  })

  it('只有上次产出时给出两行，不编造体检那行', () => {
    const out = buildSelfBriefing({
      lastOutput: '本轮推 13 条增量',
      lastOutputAt: hoursAgo(14),
      now: NOW,
    })

    expect(out).toContain('上次执行：09-16 00:00（14 小时前）')
    expect(out).toContain('上次产出：本轮推 13 条增量')
    expect(out).not.toContain('上期体检')
  })

  it('维护类任务带上期体检结论（含范围与发现数）', () => {
    const out = buildSelfBriefing({
      lastOutput: '扫了 211 条跨 Agent 工作记忆',
      lastOutputAt: hoursAgo(14),
      lastMaintenanceSummary: '偏好层接近预算上限，5 条记录有序列化残迹',
      lastMaintenanceScope: 'memory',
      lastMaintenanceFindingCount: 5,
      now: NOW,
    })

    expect(out).toContain('上期体检：偏好层接近预算上限，5 条记录有序列化残迹（范围：memory，发现 5 项）')
  })

  it('上期体检没发现问题时如实说「未发现问题」，不写成 0 项', () => {
    const out = buildSelfBriefing({
      lastOutput: null,
      lastOutputAt: hoursAgo(2),
      lastMaintenanceSummary: '资产状态正常',
      lastMaintenanceScope: 'memory',
      lastMaintenanceFindingCount: 0,
      now: NOW,
    })
    expect(out).toContain('未发现问题')
  })

  it('抬头必须点明「不是本轮任务」', () => {
    // 上次产出常带结论与数字，不点明的话模型很容易把上一轮的事再答一遍
    const out = buildSelfBriefing({
      lastOutput: '已推送 13 条',
      lastOutputAt: hoursAgo(1),
      now: NOW,
    })
    expect(out).toContain('不是本轮任务')
    expect(out).toContain('本轮任务见下方分隔线之后')
  })

  it('长产出压成单行并截断', () => {
    const out = buildSelfBriefing({
      lastOutput: `第一行\n第二行\n${'长'.repeat(600)}`,
      lastOutputAt: hoursAgo(1),
      now: NOW,
    })

    const line = out.split('\n').find((l) => l.startsWith('上次产出：'))!
    const body = line.slice('上次产出：'.length)
    expect(body).not.toContain('\n')
    expect(body.startsWith('第一行 第二行')).toBe(true)
    expect(body.length).toBe(LAST_OUTPUT_MAX_CHARS + 1)
    expect(body.endsWith('…')).toBe(true)
  })

  it('有体检但没上次产出时，仍然算「有内容」并注入', () => {
    const out = buildSelfBriefing({
      lastOutput: null,
      lastOutputAt: null,
      lastMaintenanceSummary: '上次扫出 3 项',
      lastMaintenanceScope: 'wiki',
      lastMaintenanceFindingCount: 3,
      now: NOW,
    })
    expect(out).not.toBe('')
    expect(out).toContain('上期体检')
    expect(out).not.toContain('上次执行')
  })

  it('空白产出不算产出', () => {
    expect(
      buildSelfBriefing({ lastOutput: '   \n  ', lastOutputAt: null, now: NOW }),
    ).toBe('')
  })

  it('有落库时刻但产出被哨兵过滤掉时，仍给出执行时间', () => {
    // NO_REPLY 之类由调用方过滤成 null，但"上次跑过"这件事本身仍有信息量
    const out = buildSelfBriefing({ lastOutput: null, lastOutputAt: hoursAgo(3), now: NOW })
    expect(out).toContain('上次执行')
    expect(out).not.toContain('上次产出')
  })
})
