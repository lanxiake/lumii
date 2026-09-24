/**
 * 真实 lottie-web 渲染冒烟测试 —— 验证原创 Lottie 数据可被解析并产出 SVG 形状。
 *
 * 依赖 setup.ts 里的 canvas getContext stub（jsdom 未装 canvas 包）。
 *
 * 层顺序不变量：Lottie/AE 语义 `layers[0]` 是最顶层，靠后的层被靠前的层覆盖。
 * 身体（body）必须位于 layers 数组末尾（最底层），否则会盖住眼睛/腮红/微笑，
 * 导致团子只剩一个蓝圆。这里用数据断言 + 真实渲染 DOM 顺序双重锁死。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import lottie from 'lottie-web'
import { moodLottieData } from '../../renderer/pages/AutonomousPage/MoodAvatar.lottie'

/**
 * 收拾 lottie-web 的模块级轮询定时器。
 *
 * lottie 在**模块加载时**就 `setInterval(checkReady, 100)`，而 `checkReady` 只在看到
 * `document.readyState === 'complete'` 时才 clearInterval 停掉自己。jsdom 下 readyState 停在
 * 'loading'（从没触发过 window load），于是那个 interval 会一直跑到**测试环境拆除之后**——
 * 回调里读 `document` 就抛 `ReferenceError: document is not defined`。
 *
 * 报不报取决于 100ms 周期与拆除时机的相对位置，所以它表现为**间歇性**失败：vitest 把它计入
 * `Errors`（不算某个用例失败），但会让整个 run 退出码为 1。
 *
 * 两条都要做：把 readyState 报成 complete（这正是 lottie 在等的条件），并在 afterAll 里跨过
 * 一个周期确保它真的自清了——只做前者仍可能赶上「环境拆除早于首次触发」。
 */
beforeAll(() => {
  Object.defineProperty(document, 'readyState', { configurable: true, get: () => 'complete' })
})

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 150))
  // 撤掉实例上的遮蔽，露出 Document.prototype 原本的 getter
  delete (document as unknown as { readyState?: string }).readyState
})

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
