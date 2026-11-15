/**
 * hotkey 双击判定单测 —— 纯逻辑，vitest 可跑（不加载原生模块）。
 *
 * 判定规则来自 P0-1 实测（`verify/listary-p0/hook-spike.cjs`）：
 * **一次 Ctrl 按住期间没夹别的键**才算有效点击，**不是**"两次 Ctrl 之间没夹别的键"。
 * 后者会让 `Ctrl+C` 的收尾被误判成干净点击。
 */

import { describe, expect, it } from 'vitest'

import { DOUBLE_PRESS_MS, createDoubleCtrlDetector } from './hotkey.js'

/** libuiohook 键码（P0 实测确认） */
const LCTRL = 29
const RCTRL = 3613
const C = 46
const V = 47

function make(threshold = DOUBLE_PRESS_MS): {
  keydown: (c: number) => void
  keyup: (c: number) => void
  reset: () => void
  fires: () => number
  tick: (ms: number) => void
} {
  let clock = 1_000_000
  let n = 0
  const d = createDoubleCtrlDetector({
    thresholdMs: threshold,
    now: () => clock,
    onTrigger: () => {
      n++
    },
  })
  return {
    keydown: d.keydown,
    keyup: d.keyup,
    reset: d.reset,
    fires: () => n,
    tick: (ms) => {
      clock += ms
    },
  }
}

describe('createDoubleCtrlDetector', () => {
  it('单次 Ctrl 不触发', () => {
    const d = make()
    d.keydown(LCTRL)
    d.keyup(LCTRL)
    expect(d.fires()).toBe(0)
  })

  it('两次 Ctrl（间隔在阈值内）触发', () => {
    const d = make()
    d.keydown(LCTRL)
    d.keyup(LCTRL)
    d.tick(150)
    d.keydown(LCTRL)
    d.keyup(LCTRL)
    expect(d.fires()).toBe(1)
  })

  it('间隔超阈值不触发', () => {
    const d = make()
    d.keydown(LCTRL)
    d.keyup(LCTRL)
    d.tick(900)
    d.keydown(LCTRL)
    d.keyup(LCTRL)
    expect(d.fires()).toBe(0)
  })

  it('三连击只触发一次（触发后重置）', () => {
    const d = make()
    for (let i = 0; i < 3; i++) {
      d.keydown(LCTRL)
      d.keyup(LCTRL)
      d.tick(150)
    }
    expect(d.fires()).toBe(1)
  })

  it('左右 Ctrl 混用也算双击', () => {
    const d = make()
    d.keydown(LCTRL)
    d.keyup(LCTRL)
    d.tick(120)
    d.keydown(RCTRL)
    d.keyup(RCTRL)
    expect(d.fires()).toBe(1)
  })

  // ── 下面三条是 P0 实测踩过的坑，别改 ──

  it('Ctrl+C 本身不触发', () => {
    const d = make()
    d.keydown(LCTRL)
    d.keydown(C)
    d.keyup(C)
    d.keyup(LCTRL)
    expect(d.fires()).toBe(0)
  })

  it('Ctrl+C 后紧接 Ctrl 不触发（防 Ctrl+V 误弹）', () => {
    const d = make()
    // Ctrl+C
    d.keydown(LCTRL)
    d.keydown(C)
    d.keyup(C)
    d.keyup(LCTRL)
    // 100ms 后按 Ctrl（用户想 Ctrl+V）
    d.tick(100)
    d.keydown(LCTRL)
    d.keyup(LCTRL)
    expect(d.fires()).toBe(0)
  })

  it('Ctrl+C 后重新连按两次才触发', () => {
    const d = make()
    d.keydown(LCTRL)
    d.keydown(C)
    d.keyup(C)
    d.keyup(LCTRL)
    d.tick(100)
    d.keydown(LCTRL)
    d.keyup(LCTRL)
    expect(d.fires()).toBe(0)
    d.tick(100)
    d.keydown(LCTRL)
    d.keyup(LCTRL)
    expect(d.fires()).toBe(1)
  })

  it('Modifier 用法作废的是"配对资格"，不是永久失效', () => {
    const d = make()
    // 干净的一次
    d.keydown(LCTRL)
    d.keyup(LCTRL)
    // 用户改主意去复制：Ctrl+C
    d.tick(80)
    d.keydown(LCTRL)
    d.keydown(C)
    d.keyup(C)
    d.keyup(LCTRL)
    expect(d.fires()).toBe(0)
    // 再干净地按两次应该能触发
    d.tick(200)
    d.keydown(LCTRL)
    d.keyup(LCTRL)
    d.tick(120)
    d.keydown(LCTRL)
    d.keyup(LCTRL)
    expect(d.fires()).toBe(1)
  })

  it('reset 清掉待配对状态', () => {
    const d = make()
    d.keydown(LCTRL)
    d.keyup(LCTRL)
    d.reset()
    d.tick(100)
    d.keydown(LCTRL)
    d.keyup(LCTRL)
    expect(d.fires()).toBe(0)
  })
})
