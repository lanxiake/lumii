/**
 * 真实 lottie-web 渲染冒烟测试 —— 验证原创 Lottie 数据可被解析并产出 SVG 形状。
 *
 * 依赖 setup.ts 里的 canvas getContext stub（jsdom 未装 canvas 包）。
 */

import { describe, it, expect } from 'vitest'
import lottie from 'lottie-web'
import { moodLottieData } from '../../renderer/pages/AutonomousPage/MoodAvatar.lottie'

describe('MoodAvatar Lottie 数据', () => {
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
})
