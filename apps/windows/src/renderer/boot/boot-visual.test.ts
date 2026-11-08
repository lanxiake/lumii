/**
 * 开机动画的纯逻辑自检。
 *
 * 只测不依赖 DOM 渲染的部分：阶段名映射、阶段总数、退场时长、卡住态文案。
 * 视觉呈现（分形星云、粒子、溶解退场）靠真机验收，不在单测里假装能测。
 */
import { describe, expect, it } from 'vitest'
import {
  formatStallPhaseText,
  shouldApplyFallbackCurve,
  shouldEnterStall,
  STALL_MS,
} from './boot-stall'
import { _phaseLabelFor, _TOTAL_PHASES, BOOT_FADE_MS } from './boot-visual'

describe('boot-stall 卡住态', () => {
  it('同一阶段超过阈值进入卡住态', () => {
    expect(shouldEnterStall(10_000, 3_000)).toBe(true)
    expect(shouldEnterStall(3_000 + STALL_MS, 3_000)).toBe(true)
  })

  it('未到阈值不进入卡住态', () => {
    expect(shouldEnterStall(3_000 + STALL_MS - 1, 3_000)).toBe(false)
  })

  it('完成后不再进入卡住态', () => {
    expect(shouldEnterStall(99_000, 0, { completed: true })).toBe(false)
  })

  it('卡住文案含阶段名与等待秒数', () => {
    expect(formatStallPhaseText('启动本地服务', 8)).toBe('仍在：启动本地服务 · 已等待 8s')
  })

  it('无阶段名时回退等待启动信号', () => {
    expect(formatStallPhaseText('', 6)).toBe('仍在：等待启动信号 · 已等待 6s')
  })

  it('卡住态关闭兜底曲线假爬升', () => {
    expect(
      shouldApplyFallbackCurve({ completed: false, hasRealProgress: false, stalled: true }),
    ).toBe(false)
    expect(
      shouldApplyFallbackCurve({ completed: false, hasRealProgress: false, stalled: false }),
    ).toBe(true)
  })
})

describe('boot-visual 阶段映射', () => {
  it('主进程广播的每个阶段都有中文标签（不留内部名给用户看）', () => {
    const phases = [
      'S0-app-shell',
      'S1-extensions',
      'S2-S5-ui',
      'window',
      'S6-config',
      'S7-services',
      'S7.1-seed-skills',
      'S7.2-skill-runtime',
      'S7.3-skill-watcher',
      'S7.4-agent-runtime',
      'S8-post-ready',
    ]
    for (const phase of phases) {
      expect(_phaseLabelFor(phase), phase).not.toBe(phase)
    }
  })

  it('未知阶段回退为原名，不抛错', () => {
    expect(_phaseLabelFor('S9-something-new')).toBe('S9-something-new')
  })

  it('阶段总数与主进程 BOOT_TOTAL_PHASES 一致', () => {
    expect(_TOTAL_PHASES).toBe(11)
  })

  it('溶解退场时长在能看清又不拖沓的区间（600–1500ms）', () => {
    expect(BOOT_FADE_MS).toBeGreaterThanOrEqual(600)
    expect(BOOT_FADE_MS).toBeLessThanOrEqual(1500)
  })
})
