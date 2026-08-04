/**
 * PetOrchestrator 单元测试
 * 验证语音状态→动画映射、speaking 启停口型、被动打断回 idle。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PetOrchestrator } from './PetOrchestrator'
import type { PetRendererProvider } from '../renderer/types'
import type { PetModelConfig } from '../config/pet-model-types'

let voiceCallback: ((event: unknown) => void) | null = null

function createMockRenderer(): PetRendererProvider & { motions: string[]; mouthValues: number[] } {
  const motions: string[] = []
  const mouthValues: number[] = []
  return {
    motions,
    mouthValues,
    init: vi.fn(),
    loadModel: vi.fn(),
    playMotion: vi.fn((g: string) => motions.push(g)),
    getMotionCount: vi.fn(() => 1),
    playRandomMotion: vi.fn((g: string) => motions.push(g)),
    setExpression: vi.fn(),
    setMouthOpen: vi.fn((v: number) => mouthValues.push(v)),
    hitTest: vi.fn(() => null),
    isPointerOverModel: vi.fn(() => false),
    resize: vi.fn(),
    setPosition: vi.fn(),
    getPosition: vi.fn(() => ({ x: 0, y: 0 })),
    getModelScreenBounds: vi.fn(() => null),
    setFpsCap: vi.fn(),
    getCurrentFps: vi.fn(() => 60),
    isModelLoaded: vi.fn(() => true),
    setMotionPlayedListener: vi.fn(),
    destroy: vi.fn(),
  }
}

const testConfig: PetModelConfig = {
  id: 'test',
  name: 'Test',
  rendererType: 'live2d',
  modelUrl: 'x',
  scale: 0.4,
  idleMotionGroup: 'Idle',
  talkMotionGroup: 'Talk',
  emotionMap: {},
  tapMotions: {},
  defaultExpression: 0,
}

function emitVoice(state: string, interrupted = false): void {
  voiceCallback?.({ type: 'voice:call:state', state, interrupted, callId: 'c1' })
}

describe('PetOrchestrator', () => {
  beforeEach(() => {
    voiceCallback = null
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    vi.stubGlobal('performance', { now: () => 1000 })
    vi.stubGlobal('window', {
      electronAPI: {
        voice: {
          onEvent: (cb: (event: unknown) => void) => {
            voiceCallback = cb
            return () => {}
          },
        },
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('speaking 态 → 播放 Talk 动作', () => {
    const renderer = createMockRenderer()
    const orch = new PetOrchestrator(renderer)
    orch.setModelConfig(testConfig)
    orch.start()

    emitVoice('speaking')
    expect(renderer.motions).toContain('Talk')
    orch.dispose()
  })

  it('listening 态 → 待机相位（基础待机由库续播，编排器仅更新可观测组名）', () => {
    const renderer = createMockRenderer()
    const orch = new PetOrchestrator(renderer)
    orch.setModelConfig(testConfig)
    let last: { motionGroup?: string } = {}
    orch.setStatusListener((s) => (last = s))
    orch.start()

    emitVoice('listening')
    // 基础待机交给库，编排器不再手动 playMotion(Idle)，但仍在可观测状态里标注待机组
    expect(last.motionGroup).toBe('Idle')
    orch.dispose()
  })

  it('被动打断（listening + interrupted）→ 回待机相位 且嘴型归零', () => {
    const renderer = createMockRenderer()
    const orch = new PetOrchestrator(renderer)
    orch.setModelConfig(testConfig)
    let last: { motionGroup?: string } = {}
    orch.setStatusListener((s) => (last = s))
    // 提供 analyser 让 speaking 能启动口型
    orch.setPlaybackAnalyser({
      fftSize: 4,
      getFloatTimeDomainData: (b: Float32Array) => b.fill(0.5),
    } as unknown as AnalyserNode)
    orch.start()

    emitVoice('speaking')
    emitVoice('listening', true) // 打断
    // 打断后最后一次嘴型应为 0
    expect(renderer.mouthValues[renderer.mouthValues.length - 1]).toBe(0)
    expect(last.motionGroup).toBe('Idle')
    orch.dispose()
  })

  it('通话结束 → 回待机相位', () => {
    const renderer = createMockRenderer()
    const orch = new PetOrchestrator(renderer)
    orch.setModelConfig(testConfig)
    let last: { motionGroup?: string } = {}
    orch.setStatusListener((s) => (last = s))
    orch.start()

    voiceCallback?.({ type: 'voice:call:ended', callId: 'c1' })
    expect(last.motionGroup).toBe('Idle')
    orch.dispose()
  })

  it('使用模型配置的自定义动作组名', () => {
    const renderer = createMockRenderer()
    const orch = new PetOrchestrator(renderer)
    orch.setModelConfig({ ...testConfig, idleMotionGroup: 'Rest', talkMotionGroup: 'Speak' })
    let last: { motionGroup?: string } = {}
    orch.setStatusListener((s) => (last = s))
    orch.start()

    emitVoice('speaking')
    expect(renderer.motions).toContain('Speak')
    emitVoice('listening')
    // 自定义待机组 Rest 已喂给库续播，编排器在可观测状态标注它
    expect(last.motionGroup).toBe('Rest')
    orch.dispose()
  })

  it('dispose 后不再响应事件', () => {
    const renderer = createMockRenderer()
    const orch = new PetOrchestrator(renderer)
    orch.setModelConfig(testConfig)
    orch.start()
    orch.dispose()

    const before = renderer.motions.length
    emitVoice('speaking')
    expect(renderer.motions.length).toBe(before)
  })

  it('文字回复自然结束收尾中忽略重复结束，打断仍可硬停', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1)
    const renderer = createMockRenderer()
    const orch = new PetOrchestrator(renderer)
    orch.setModelConfig(testConfig)

    orch.startTextReply(false)
    orch.notifyTextDelta('这是一段需要继续读完的文字')

    const fakeLipSync = (orch as unknown as { fakeLipSync: { finish: (cb?: () => void) => void; isRunning: () => boolean } }).fakeLipSync
    const finishSpy = vi.spyOn(fakeLipSync, 'finish')

    orch.endTextReply()
    orch.endTextReply()

    expect(finishSpy).toHaveBeenCalledTimes(1)
    expect(fakeLipSync.isRunning()).toBe(true)

    orch.endTextReply(true)

    expect(finishSpy).toHaveBeenCalledTimes(1)
    expect(fakeLipSync.isRunning()).toBe(false)
    expect(renderer.mouthValues[renderer.mouthValues.length - 1]).toBe(0)
    orch.dispose()
  })

  it('动作按朗读进度对齐触发：读到 atChar 才播', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1) // 冻结 loop，手动驱动进度
    const renderer = createMockRenderer()
    const orch = new PetOrchestrator(renderer)
    orch.setModelConfig(testConfig)
    orch.setActionMotions({ wave: { group: 'Wave', index: 0 } })

    orch.startTextReply(false)
    orch.notifyTextDelta('先说一段话然后挥手') // 注入 backlog，fakeLipSync 运行中

    const motionsBefore = renderer.motions.length
    // 动作标注在第 8 个字处
    orch.playActionMotion('wave', 8)
    // 尚未读到 → 不应播放
    expect(renderer.motions.length).toBe(motionsBefore)

    const progress = (orch as unknown as { onReadingProgress: (n: number) => void }).onReadingProgress.bind(orch)
    progress(5) // 读到第 5 字，未达 8
    expect(renderer.motions.length).toBe(motionsBefore)
    progress(8) // 读到第 8 字 → 触发
    expect(renderer.motions).toContain('Wave')
    orch.dispose()
  })

  it('已读过的位置：动作立即触发（迟到标签不丢）', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1)
    const renderer = createMockRenderer()
    const orch = new PetOrchestrator(renderer)
    orch.setModelConfig(testConfig)
    orch.setActionMotions({ nod: { group: 'Nod', index: 0 } })

    orch.startTextReply(false)
    orch.notifyTextDelta('一段较长的文字内容用于驱动伪口型')
    const progress = (orch as unknown as { onReadingProgress: (n: number) => void }).onReadingProgress.bind(orch)
    progress(20) // 已读到 20 字

    const before = renderer.motions.length
    orch.playActionMotion('nod', 10) // 标签位置 10 < 已读 20 → 立即播
    expect(renderer.motions.length).toBe(before + 1)
    expect(renderer.motions).toContain('Nod')
    orch.dispose()
  })

  it('打断硬停清空未触发动作队列', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1)
    const renderer = createMockRenderer()
    const orch = new PetOrchestrator(renderer)
    orch.setModelConfig(testConfig)
    orch.setActionMotions({ wave: { group: 'Wave', index: 0 } })

    orch.startTextReply(false)
    orch.notifyTextDelta('文字内容')
    orch.playActionMotion('wave', 99) // 排到很后面，远未读到

    orch.endTextReply(true) // 打断硬停 → 应清空队列
    const after = renderer.motions.length
    const progress = (orch as unknown as { onReadingProgress: (n: number) => void }).onReadingProgress.bind(orch)
    progress(200) // 即便进度超过 99，也不应再触发（队列已清空）
    expect(renderer.motions.length).toBe(after)
    expect(renderer.motions).not.toContain('Wave')
    orch.dispose()
  })

  it('无偏移（真音频路径）动作立即播放', () => {
    const renderer = createMockRenderer()
    const orch = new PetOrchestrator(renderer)
    orch.setModelConfig(testConfig)
    orch.setActionMotions({ wave: { group: 'Wave', index: 0 } })
    // 未启动伪口型（fakeLipSync 未运行）→ 无朗读进度可对齐
    const before = renderer.motions.length
    orch.playActionMotion('wave') // atChar 省略
    expect(renderer.motions.length).toBe(before + 1)
    expect(renderer.motions).toContain('Wave')
    orch.dispose()
  })

  it('对话结束后 10s 内不调度随机待机', () => {
    vi.useFakeTimers()
    const renderer = createMockRenderer()
    vi.mocked(renderer.getMotionCount).mockImplementation((g: string) => (g === 'Idle' ? 1 : 3))
    const orch = new PetOrchestrator(renderer)
    orch.setModelConfig({
      ...testConfig,
      idleMotionFallbackGroup: '$unnamed',
    })
    let last: { postDialogueCooldown?: boolean } = {}
    orch.setStatusListener((s) => (last = s))
    orch.start()
    const randomBefore = vi.mocked(renderer.playRandomMotion).mock.calls.length

    orch.setDialogueActive(true)
    orch.onDialogueEnded()

    // 基础待机由库续播：编排器不再手动 playMotion('Idle')，仅进入冷却状态
    expect(last.postDialogueCooldown).toBe(true)
    expect(vi.mocked(renderer.playRandomMotion).mock.calls.length).toBe(randomBefore)

    vi.advanceTimersByTime(9_999)
    expect(vi.mocked(renderer.playRandomMotion).mock.calls.length).toBe(randomBefore)

    vi.advanceTimersByTime(1)
    // 冷却结束后恢复装饰随机轮播（$unnamed 组有 3 个动作，≠ idle 组）
    expect(vi.mocked(renderer.playRandomMotion).mock.calls.length).toBeGreaterThan(randomBefore)

    orch.dispose()
    vi.useRealTimers()
  })
})
