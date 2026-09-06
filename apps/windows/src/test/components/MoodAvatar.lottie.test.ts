/**
 * 真实 lottie-web 渲染冒烟测试 —— 验证原创 Lottie 数据可被解析并产出 SVG 形状。
 *
 * 依赖 setup.ts 里的 canvas getContext stub（jsdom 未装 canvas 包）。
 *
 * 层顺序不变量：Lottie/AE 语义 `layers[0]` 是最顶层，靠后的层被靠前的层覆盖。
 * 身体（body）必须位于 layers 数组末尾（最底层），否则会盖住眼睛/腮红/微笑，
 * 导致团子只剩一个蓝圆。这里用数据断言 + 真实渲染 DOM 顺序双重锁死。
 */

import { describe, it, expect } from 'vitest'
import lottie from 'lottie-web'
import { moodLottieData } from '../../renderer/pages/AutonomousPage/MoodAvatar.lottie'

const TEAL_BODY = 'rgb(132,211,232)'
const DARK_FEATURE = 'rgb(33,40,51)'

function layerNames() {
  return moodLottieData.layers.map((l) => l.nm)
}

describe('MoodAvatar Lottie 数据', () => {
  it('身体位于最底层，面部特征位于其上', () => {
    const names = layerNames()
    expect(names[names.length - 1]).toBe('body')
    expect(names[0]).toBe('smile')
    // 面部特征（微笑/眼睛/腮红/高光）都在身体之前 = 更顶层
    expect(names.slice(0, -1)).toEqual(
      expect.arrayContaining(['smile', 'eye_l', 'eye_r', 'blush_l', 'blush_r', 'gloss']),
    )
  })

  it('可被真实 lottie-web 装载并渲染出 SVG 形状', () => {
    const container = document.createElement('div')
    const anim = lottie.loadAnimation({
      container,
      renderer: 'svg',
      loop: true,
      autoplay: false,
      animationData: moodLottieData,
    })

    expect(anim).toBeTruthy()
    const svg = container.querySelector('svg')
    expect(svg).toBeTruthy()

    // 团子应有身体/眼睛/腮红/微笑等形状元素
    const shapes = svg!.querySelectorAll('path, ellipse, circle, rect')
    expect(shapes.length).toBeGreaterThan(0)

    anim.destroy()
  })

  it('真实渲染中身体在 DOM 前部（最底层），不被面部特征遮挡', () => {
    const container = document.createElement('div')
    const anim = lottie.loadAnimation({
      container,
      renderer: 'svg',
      loop: true,
      autoplay: false,
      animationData: moodLottieData,
    })

    const svg = container.querySelector('svg')!
    const filled = Array.from(svg.querySelectorAll('path')).filter(
      (p) => p.getAttribute('fill') !== null && p.getAttribute('fill') !== 'none',
    )

    const bodyIdx = filled.findIndex((p) => p.getAttribute('fill') === TEAL_BODY)
    const featureIdx = filled.findIndex((p) => p.getAttribute('fill') === DARK_FEATURE)

    expect(bodyIdx).toBeGreaterThanOrEqual(0)
    expect(featureIdx).toBeGreaterThanOrEqual(0)
    // body 在 DOM 中更靠前 = SVG 中更底层
    expect(bodyIdx).toBeLessThan(featureIdx)

    anim.destroy()
  })
})
