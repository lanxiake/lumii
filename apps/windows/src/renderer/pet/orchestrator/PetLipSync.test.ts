/**
 * PetLipSync 单元测试
 * 验证 RMS 计算、归一化、speaking 态门控、打断归零。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PetLipSync } from './PetLipSync'
import type { PetRendererProvider } from '../renderer/types'

/** 构造一个最小 renderer mock，只关心 setMouthOpen */
function createMockRenderer(): PetRendererProvider & { mouthValues: number[] } {
  const mouthValues: number[] = []
  return {
    mouthValues,
    init: vi.fn(),
    loadModel: vi.fn(),
    playMotion: vi.fn(),
    getMotionCount: vi.fn(() => 1),
    playRandomMotion: vi.fn(),
    setExpression: vi.fn(),
    setMouthOpen: vi.fn((v: number) => {
      mouthValues.push(v)
    }),
    releaseLipSync: vi.fn(() => {
      mouthValues.push(0)
    }),
    hitTest: vi.fn(() => null),
    isPointerOverModel: vi.fn(() => false),
    resize: vi.fn(),
    setPosition: vi.fn(),
    getPosition: vi.fn(() => ({ x: 0, y: 0 })),
    getModelScreenBounds: vi.fn(() => null),
    setFpsCap: vi.fn(),
    getCurrentFps: vi.fn(() => 60),
    isModelLoaded: vi.fn(() => true),
    destroy: vi.fn(),
  }
}

/** 构造一个 AnalyserNode mock，getFloatTimeDomainData 填充给定波形 */
function createMockAnalyser(waveform: number[]): AnalyserNode {
  return {
    fftSize: waveform.length,
    getFloatTimeDomainData: (buf: Float32Array) => {
      for (let i = 0; i < buf.length; i++) buf[i] = waveform[i] ?? 0
    },
  } as unknown as AnalyserNode
}

describe('PetLipSync', () => {
  let rafCb: FrameRequestCallback | null = null

  beforeEach(() => {
    // 同步触发一次 rAF，便于断言单帧行为
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCb = cb
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {
      rafCb = null
    })
    vi.stubGlobal('performance', { now: () => 1000 })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    rafCb = null
  })

  it('静音波形（全 0）→ 嘴开度为 0', () => {
    const renderer = createMockRenderer()
    const lip = new PetLipSync(renderer)
    lip.setAnalyser(createMockAnalyser([0, 0, 0, 0]))
    lip.start()
    expect(renderer.mouthValues[renderer.mouthValues.length - 1]).toBe(0)
  })

  it('有振幅波形 → 嘴开度 > 0 且 ≤ 1', () => {
    const renderer = createMockRenderer()
    const lip = new PetLipSync(renderer)
    // 满幅方波 RMS=1，乘增益后被 clamp 到 1
    lip.setAnalyser(createMockAnalyser([1, -1, 1, -1]))
    lip.start()
    const last = renderer.mouthValues[renderer.mouthValues.length - 1]
    expect(last).toBeGreaterThan(0)
    expect(last).toBeLessThanOrEqual(1)
  })

  it('未设置 analyser 时 start 不报错且不轮询', () => {
    const renderer = createMockRenderer()
    const lip = new PetLipSync(renderer)
    expect(() => lip.start()).not.toThrow()
    expect(lip.isRunning()).toBe(false)
  })

  it('stop 归零嘴型并停止运行', () => {
    const renderer = createMockRenderer()
    const lip = new PetLipSync(renderer)
    lip.setAnalyser(createMockAnalyser([0.5, -0.5, 0.5, -0.5]))
    lip.start()
    expect(lip.isRunning()).toBe(true)
    lip.stop()
    expect(lip.isRunning()).toBe(false)
    // stop 后最后一次 setMouthOpen 应为 0
    expect(renderer.mouthValues[renderer.mouthValues.length - 1]).toBe(0)
  })

  it('重复 start 不重复启动（幂等）', () => {
    const renderer = createMockRenderer()
    const lip = new PetLipSync(renderer)
    lip.setAnalyser(createMockAnalyser([0.3, -0.3]))
    lip.start()
    const countAfterFirst = renderer.mouthValues.length
    lip.start() // 第二次应被忽略
    expect(renderer.mouthValues.length).toBe(countAfterFirst)
  })

  it('dispose 后清理 analyser', () => {
    const renderer = createMockRenderer()
    const lip = new PetLipSync(renderer)
    lip.setAnalyser(createMockAnalyser([0.5]))
    lip.start()
    lip.dispose()
    expect(lip.isRunning()).toBe(false)
  })

  it('连续帧 RMS 平滑（EMA）：突变不会瞬间跳满', () => {
    const renderer = createMockRenderer()
    const lip = new PetLipSync(renderer)
    lip.setAnalyser(createMockAnalyser([1, -1, 1, -1]))
    lip.start()
    // 第一帧因平滑系数不会立刻到 1
    const first = renderer.mouthValues[0]
    expect(first).toBeLessThan(1)
    expect(first).toBeGreaterThan(0)
  })

  it('发声帧保底可见开口：中低能量语音也重映射到 ≥0.4，避免"看不出口型"', () => {
    const renderer = createMockRenderer()
    const lip = new PetLipSync(renderer)
    // 中低能量语音段（RMS≈0.1，越过噪声门但整形前偏小），实机曾只输出 mouth≈0.1~0.3
    lip.setAnalyser(createMockAnalyser([0.1, -0.1, 0.1, -0.1]))
    lip.start()
    // 跑若干帧让 EMA 收敛，断言稳定后的开口显著可见（越过用户要求的 0.4 阈值）
    for (let i = 0; i < 10; i++) rafCb?.(0)
    const last = renderer.mouthValues[renderer.mouthValues.length - 1]
    expect(last).toBeGreaterThan(0.4)
    expect(last).toBeLessThanOrEqual(1)
  })

  it('finish() 从未运行 → 立即回调（无音频可跟随）', () => {
    const renderer = createMockRenderer()
    const lip = new PetLipSync(renderer)
    const onDrained = vi.fn()
    lip.finish(onDrained)
    expect(onDrained).toHaveBeenCalledTimes(1)
  })

  it('finish() 后先有音频、再持续无音超过阈值 → 闭嘴并触发收尾回调', () => {
    let nowMs = 1000
    vi.stubGlobal('performance', { now: () => nowMs })
    const renderer = createMockRenderer()
    const lip = new PetLipSync(renderer)
    // 可切换波形：先有音频（听到过），再切静音触发无音收尾
    let wave = [1, -1, 1, -1]
    const analyser = {
      fftSize: 4,
      getFloatTimeDomainData: (buf: Float32Array) => {
        for (let i = 0; i < buf.length; i++) buf[i] = wave[i] ?? 0
      },
    } as unknown as AnalyserNode
    lip.setAnalyser(analyser)
    lip.start()
    expect(lip.isRunning()).toBe(true)

    const onDrained = vi.fn()
    lip.finish(onDrained) // drainStartTs = lastVoiceTs = 1000
    // 先跑一帧有音频：heardVoice=true、lastVoiceTs 刷新
    nowMs = 1100
    rafCb?.(0)
    expect(onDrained).not.toHaveBeenCalled()
    // 切静音：EMA 平滑使口开度逐帧衰减（0.5→0.25→…），跑若干帧让其降到无音阈值以下
    wave = [0, 0, 0, 0]
    for (let i = 0; i < 8 && lip.isRunning(); i++) {
      nowMs += 20
      rafCb?.(0)
    }
    // 此时口开度已收敛到 ~0，再推进超过 SILENCE_HOLD_MS(450ms) → 无音收尾
    nowMs += 600
    rafCb?.(0)
    expect(onDrained).toHaveBeenCalledTimes(1)
    expect(lip.isRunning()).toBe(false)
    expect(renderer.mouthValues[renderer.mouthValues.length - 1]).toBe(0)
  })

  it('finish() 后音频始终未到达（TTS 合成延迟）→ 不因静音提前闭嘴', () => {
    let nowMs = 1000
    vi.stubGlobal('performance', { now: () => nowMs })
    const renderer = createMockRenderer()
    const lip = new PetLipSync(renderer)
    // 全程静音：模拟 TTS 音频尚未合成到达。此时不得因"连续静音"误判为播放结束。
    lip.setAnalyser(createMockAnalyser([0, 0, 0, 0]))
    lip.start()
    const onDrained = vi.fn()
    lip.finish(onDrained)
    // 即便远超 SILENCE_HOLD_MS，只要从未听到音频，就不能收尾（等音频到达或 MAX_DRAIN_MS 兜底）
    nowMs = 3000
    rafCb?.(0)
    expect(onDrained).not.toHaveBeenCalled()
    expect(lip.isRunning()).toBe(true)
    lip.stop()
  })

  it('finish() 后仍有音频 → 不收尾，继续跟随口型', () => {
    let nowMs = 1000
    vi.stubGlobal('performance', { now: () => nowMs })
    const renderer = createMockRenderer()
    const lip = new PetLipSync(renderer)
    // 满幅波形：口开度持续 >0，视为音频仍在播放
    lip.setAnalyser(createMockAnalyser([1, -1, 1, -1]))
    lip.start()

    const onDrained = vi.fn()
    lip.finish(onDrained)
    // 即使推进时间，只要每帧都有音频（lastVoiceTs 持续刷新），就不应收尾
    nowMs = 2000
    rafCb?.(0)
    expect(onDrained).not.toHaveBeenCalled()
    expect(lip.isRunning()).toBe(true)
  })

  it('drain 期间硬 stop → 不触发收尾回调', () => {
    let nowMs = 1000
    vi.stubGlobal('performance', { now: () => nowMs })
    const renderer = createMockRenderer()
    const lip = new PetLipSync(renderer)
    lip.setAnalyser(createMockAnalyser([0, 0, 0, 0]))
    lip.start()
    const onDrained = vi.fn()
    lip.finish(onDrained)
    lip.stop() // 硬停（打断）
    expect(onDrained).not.toHaveBeenCalled()
    expect(lip.isRunning()).toBe(false)
  })
})
