/**
 * MoodAvatar 冒烟测试
 *
 * 注：lottie-web 在模块加载时就会创建 canvas 并调用 getContext('2d')，
 * jsdom 未装 canvas 包无法直接 import 真实实现。这里 mock lottie-web，
 * 只验证组件接线（loadAnimation 参数、setSpeed 调用、情绪徽标渲染），
 * 并对原创 Lottie 数据做结构完整性校验。真实渲染需在 Electron 渲染进程验证。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { MoodAvatar, moodToEmotion } from '../../renderer/pages/AutonomousPage/MoodAvatar'
import { moodLottieData } from '../../renderer/pages/AutonomousPage/MoodAvatar.lottie'

const { loadAnimation } = vi.hoisted(() => ({
  loadAnimation: vi.fn(() => ({ setSpeed: vi.fn(), destroy: vi.fn() })),
}))

vi.mock('lottie-web', () => ({ default: { loadAnimation } }))

describe('MoodAvatar', () => {
  beforeEach(() => {
    loadAnimation.mockClear()
  })

  it('moodToEmotion 正确映射三维情绪', () => {
    expect(moodToEmotion({ energy: 0.8, valence: 0.5, arousal: 0.3 })).toBe('joy')
    expect(moodToEmotion({ energy: 0.2, valence: 0, arousal: 0.3 })).toBe('sleepy')
    expect(moodToEmotion({ energy: 0.5, valence: -0.5, arousal: 0.3 })).toBe('sadness')
    expect(moodToEmotion({ energy: 0.5, valence: 0, arousal: 0.8 })).toBe('surprise')
    expect(moodToEmotion({ energy: 0.5, valence: 0, arousal: 0.3 })).toBe('neutral')
  })

  it('Lottie 数据结构完整（顶字段 + 图层 + 形状组）', () => {
    expect(moodLottieData).toMatchObject({
      v: expect.any(String),
      fr: expect.any(Number),
      w: 120,
      h: 120,
    })
    expect(Array.isArray(moodLottieData.layers)).toBe(true)
    expect(moodLottieData.layers.length).toBeGreaterThan(0)
    for (const layer of moodLottieData.layers) {
      expect(layer.ty).toBe(4)
      expect(layer.ks).toBeTruthy()
      expect(Array.isArray(layer.shapes)).toBe(true)
    }
  })

  it('渲染团子时装载 Lottie 并显示情绪徽标', () => {
    render(<MoodAvatar mood={{ energy: 0.8, valence: 0.5, arousal: 0.3 }} />)

    expect(screen.getByText('开心')).toBeInTheDocument()
    expect(loadAnimation).toHaveBeenCalledTimes(1)
    expect(loadAnimation).toHaveBeenCalledWith(
      expect.objectContaining({
        animationData: moodLottieData,
        renderer: 'svg',
        loop: true,
        autoplay: true,
      }),
    )
  })
})
