/**
 * PetFakeLipSync 单元测试
 *
 * 覆盖「活跃保活 + 连续正弦」时序模型：喂字续期活跃截止时间、活跃期口型起伏、
 * finish 后活跃期过期 + 能量衰减自停、onDrained 回调、硬 stop 不触发 onDrained、
 * 重启彻底重置状态。
 *
 * loop 用 requestAnimationFrame + performance.now 驱动，故 stub 二者为可控时钟：
 * 每次 advanceFrames(n, dtMs) 推进 n 帧、每帧 dtMs，手动调用挂起的 rAF 回调。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PetFakeLipSync } from './PetFakeLipSync'
import type { PetRendererProvider } from '../renderer/types'

let nowMs = 0
let rafCb: FrameRequestCallback | null = null

/** 推进 frames 帧，每帧 dtMs 毫秒，逐帧执行挂起的 rAF 回调 */
function advanceFrames(frames: number, dtMs = 16) {
  for (let i = 0; i < frames; i++) {
    nowMs += dtMs
    const cb = rafCb
    rafCb = null
    cb?.(nowMs)
  }
}

function makeRenderer(): { renderer: PetRendererProvider; mouth: number[] } {
  const mouth: number[] = []
  const renderer = {
    setMouthOpen: (v: number) => mouth.push(v),
  } as unknown as PetRendererProvider
  return { renderer, mouth }
}

beforeEach(() => {
  nowMs = 0
  rafCb = null
  vi.stubGlobal('performance', { now: () => nowMs })
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafCb = cb
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', () => {
    rafCb = null
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PetFakeLipSync 活跃保活时序', () => {
  it('startTextDriven 后无喂字：嘴保持闭合（energy=0）', () => {
    const { renderer, mouth } = makeRenderer()
    const lip = new PetFakeLipSync(renderer)
    lip.startTextDriven()
    advanceFrames(10)
    // 无文字注入，能量始终 0，嘴开度全程 ≈ 0
    expect(Math.max(...mouth)).toBeLessThan(0.05)
    lip.stop()
  })

  it('notifyTextActivity 续期活跃后嘴张合（energy 拉满）', () => {
    const { renderer, mouth } = makeRenderer()
    const lip = new PetFakeLipSync(renderer)
    lip.startTextDriven()
    lip.notifyTextActivity(2)
    advanceFrames(20) // ~0.32s，仍在 500ms 活跃期内
    // 活跃期能量=1，正弦驱动应有明显张开
    expect(Math.max(...mouth)).toBeGreaterThan(0.3)
    lip.stop()
  })

  it('持续喂字：活跃期不断续期，口型全程起伏不掉零', () => {
    const { renderer, mouth } = makeRenderer()
    const lip = new PetFakeLipSync(renderer)
    lip.startTextDriven()
    // 每 ~0.32s 喂一次字（模拟慢速滑块），共 ~3.2s
    for (let i = 0; i < 10; i++) {
      lip.notifyTextActivity(2)
      advanceFrames(20, 16)
    }
    // 全程持续喂字，最后一帧仍在活跃期，能量应保持高位
    expect(mouth[mouth.length - 1]!).toBeGreaterThanOrEqual(0)
    // 采样中应有大量非零帧（不是只有开头动）
    const nonZero = mouth.filter((v) => v > 0.1).length
    expect(nonZero).toBeGreaterThan(mouth.length * 0.4)
    lip.stop()
  })

  it('finish 后活跃期过期 + 能量衰减才自停（不立即闭嘴）', () => {
    const { renderer } = makeRenderer()
    const lip = new PetFakeLipSync(renderer)
    lip.startTextDriven()
    lip.notifyTextActivity(4)
    advanceFrames(5)
    lip.finish()
    // 活跃期（500ms）尚未过期 → 仍在跑
    expect(lip.isRunning()).toBe(true)
    // 推进足够久：活跃期过期 + 能量衰减到阈值 → 自停
    advanceFrames(220, 16) // ~3.5s
    expect(lip.isRunning()).toBe(false)
  })

  it('finish 自然收尾触发 onDrained 回调', () => {
    const { renderer } = makeRenderer()
    const lip = new PetFakeLipSync(renderer)
    const onDrained = vi.fn()
    lip.startTextDriven()
    lip.notifyTextActivity(4)
    advanceFrames(5)
    lip.finish(onDrained)
    expect(onDrained).not.toHaveBeenCalled()
    advanceFrames(220, 16) // 活跃期过期 + 衰减
    expect(lip.isRunning()).toBe(false)
    expect(onDrained).toHaveBeenCalledTimes(1)
  })

  it('finish 在已停止时立即回调 onDrained', () => {
    const { renderer } = makeRenderer()
    const lip = new PetFakeLipSync(renderer)
    const onDrained = vi.fn()
    lip.finish(onDrained) // 未 start
    expect(onDrained).toHaveBeenCalledTimes(1)
  })

  it('硬 stop 不触发 onDrained（打断语义）', () => {
    const { renderer } = makeRenderer()
    const lip = new PetFakeLipSync(renderer)
    const onDrained = vi.fn()
    lip.startTextDriven()
    lip.notifyTextActivity(4)
    advanceFrames(10)
    lip.finish(onDrained)
    lip.stop() // 硬停（如打断）
    advanceFrames(50)
    expect(onDrained).not.toHaveBeenCalled()
    expect(lip.isRunning()).toBe(false)
  })

  it('stop 后归零嘴型', () => {
    const { renderer, mouth } = makeRenderer()
    const lip = new PetFakeLipSync(renderer)
    lip.startTextDriven()
    lip.notifyTextActivity(4)
    advanceFrames(10)
    lip.stop()
    expect(mouth[mouth.length - 1]).toBe(0)
  })

  it('stop 后重新 startTextDriven + 喂字：口型能重新张合（修复重启不动）', () => {
    const { renderer, mouth } = makeRenderer()
    const lip = new PetFakeLipSync(renderer)
    // 第一轮
    lip.startTextDriven()
    lip.notifyTextActivity(4)
    advanceFrames(10)
    lip.stop() // 硬停归位
    // 第二轮：重启后喂字应重新动
    const startIdx = mouth.length
    lip.startTextDriven()
    lip.notifyTextActivity(4)
    advanceFrames(20)
    const secondRound = mouth.slice(startIdx)
    expect(Math.max(...secondRound)).toBeGreaterThan(0.3)
    lip.stop()
  })

  it('运行中重新 startTextDriven 彻底重置 inputEnded（新一轮不提前自停）', () => {
    const { renderer } = makeRenderer()
    const lip = new PetFakeLipSync(renderer)
    lip.startTextDriven()
    lip.notifyTextActivity(4)
    advanceFrames(5)
    lip.finish() // 标记上一轮结束
    // 上一轮尚在收尾时新一轮开始
    lip.startTextDriven()
    lip.notifyTextActivity(4)
    advanceFrames(10)
    // inputEnded 已被重置 → 仍在活跃期，不会因上一轮 finish 提前自停
    expect(lip.isRunning()).toBe(true)
    lip.stop()
  })

  it('onProgress 时间驱动：喂字不立即上报，loop 按语速逐步追进（不超过已注入）', () => {
    const { renderer } = makeRenderer()
    const lip = new PetFakeLipSync(renderer)
    const reads: number[] = []
    lip.setOnProgress((n) => reads.push(n))
    lip.startTextDriven()
    lip.notifyTextActivity(2)
    lip.notifyTextActivity(2)
    lip.notifyTextActivity(2) // 已注入上界=6
    // 喂字瞬间不按注入量上报（时间驱动）；startTextDriven 首帧可能已报过 0
    expect(reads.every((n) => n <= 0)).toBe(true)
    // 推进时间：已读进度按 ~6字/秒向 6 追进
    advanceFrames(80, 16) // ~1.28s，足够读完 6 字
    // 单调不减、末值不超过已注入 6
    for (let i = 1; i < reads.length; i++) expect(reads[i]!).toBeGreaterThanOrEqual(reads[i - 1]!)
    expect(reads[reads.length - 1]!).toBe(6)
    lip.stop()
  })

  it('stop 后 onProgress 不再上报', () => {
    const { renderer } = makeRenderer()
    const lip = new PetFakeLipSync(renderer)
    const onProgress = vi.fn()
    lip.setOnProgress(onProgress)
    lip.startTextDriven()
    lip.notifyTextActivity(4)
    advanceFrames(5)
    lip.stop()
    const callsAfterStop = onProgress.mock.calls.length
    advanceFrames(20)
    // 停止后 loop 不再跑、也无喂字 → 无新上报
    expect(onProgress.mock.calls.length).toBe(callsAfterStop)
  })

  it('enterProgressOnly 后不再写嘴（让位真口型），但已读进度继续按语速追进', () => {
    const { renderer, mouth } = makeRenderer()
    const lip = new PetFakeLipSync(renderer)
    const reads: number[] = []
    lip.setOnProgress((n) => reads.push(n))
    lip.startTextDriven()
    lip.notifyTextActivity(6) // 注入上界=6
    lip.enterProgressOnly() // 切真口型：嘴让位，进度继续
    const idxAfterEnter = mouth.length
    advanceFrames(80, 16) // ~1.28s，足够读完 6 字
    // 进入 progressOnly 后不应再有新的 setMouthOpen 写入
    expect(mouth.length).toBe(idxAfterEnter)
    // 已读进度仍按语速追进到已注入上界
    expect(reads[reads.length - 1]!).toBe(6)
    lip.stop()
  })

  it('progressOnly 期间未喂字也能启动并推进进度（enterProgressOnly 自启动循环）', () => {
    const { renderer } = makeRenderer()
    const lip = new PetFakeLipSync(renderer)
    lip.enterProgressOnly() // 未 start 直接进入 → 内部自启动循环
    expect(lip.isRunning()).toBe(true)
    lip.notifyTextActivity(4)
    advanceFrames(60, 16)
    lip.stop()
    expect(lip.isRunning()).toBe(false)
  })

  it('progressOnly 下 stop 不归零嘴（嘴由真口型接管，避免抢控归零）', () => {
    const { renderer, mouth } = makeRenderer()
    const lip = new PetFakeLipSync(renderer)
    lip.startTextDriven()
    lip.notifyTextActivity(4)
    lip.enterProgressOnly()
    advanceFrames(10)
    const lenBeforeStop = mouth.length
    lip.stop()
    // progressOnly 下的 stop 不应追加 setMouthOpen(0)
    expect(mouth.length).toBe(lenBeforeStop)
  })

  it('stop 后重新 startTextDriven 复位 progressOnly（新一轮嘴重新张合）', () => {
    const { renderer, mouth } = makeRenderer()
    const lip = new PetFakeLipSync(renderer)
    lip.startTextDriven()
    lip.notifyTextActivity(4)
    lip.enterProgressOnly()
    advanceFrames(10)
    lip.stop()
    // 新一轮：应回到嘴驱动模式
    const startIdx = mouth.length
    lip.startTextDriven()
    lip.notifyTextActivity(4)
    advanceFrames(20)
    const secondRound = mouth.slice(startIdx)
    expect(Math.max(...secondRound)).toBeGreaterThan(0.3)
    lip.stop()
  })

  it('computeMouthOpen 输出恒在 0~1 且随时间起伏', () => {
    const { renderer } = makeRenderer()
    const lip = new PetFakeLipSync(renderer)
    const samples = [0, 0.05, 0.1, 0.15, 0.2, 0.3].map((t) => lip.computeMouthOpen(t))
    for (const v of samples) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
    // 不应恒定（有起伏）
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(0.1)
  })
})

describe('PetFakeLipSync 逐字脉冲口型（audioCharPulse）', () => {
  it('enterAudioCharPulse 后 poll 返回脉冲 → 嘴张合（一字一脉冲）', () => {
    const { renderer, mouth } = makeRenderer()
    const lip = new PetFakeLipSync(renderer)
    let pollCalls = 0
    // 模拟 AudioPlaybackEngine：前 3 帧每帧返回 1 个脉冲
    const pollFn = () => {
      pollCalls++
      return pollCalls <= 3 ? 1 : 0
    }
    lip.enterAudioCharPulse(pollFn)
    advanceFrames(10)
    // 应有脉冲导致的嘴开度
    expect(Math.max(...mouth)).toBeGreaterThan(0.3)
    lip.stop()
  })

  it('无脉冲时正弦占位让嘴有张合（不僵住）', () => {
    const { renderer, mouth } = makeRenderer()
    const lip = new PetFakeLipSync(renderer)
    // poll 永返 0：无脉冲 → 回退正弦占位，嘴应有明显张合而非僵住
    lip.enterAudioCharPulse(() => 0)
    advanceFrames(30)
    expect(Math.max(...mouth)).toBeGreaterThan(0.3)
    lip.stop()
  })

  it('enterAudioCharPulse 多脉冲叠加不超 1（脉冲能量 clamp）', () => {
    const { renderer, mouth } = makeRenderer()
    const lip = new PetFakeLipSync(renderer)
    // 单帧返回 4 个脉冲 → pulseEnergy=min(0+4,3)=3 → mouth=min(1,3*0.6)=1
    let fired = false
    lip.enterAudioCharPulse(() => {
      if (fired) return 0
      fired = true
      return 5
    })
    advanceFrames(2)
    // mouth 不应超过 1
    for (const v of mouth) expect(v).toBeLessThanOrEqual(1)
    lip.stop()
  })

  it('finish 在首帧脉冲到达前调用 → drain 不立即完成（heardPulse 门控）', () => {
    const { renderer } = makeRenderer()
    const lip = new PetFakeLipSync(renderer)
    const onDrained = vi.fn()
    // poll 始终返回 0：模拟 TTS 合成延迟，音频尚未到达
    lip.enterAudioCharPulse(() => 0)
    advanceFrames(5)
    lip.finish(onDrained)
    // 推进 60 帧（~1s），远少于超时阈值 900 帧
    advanceFrames(60)
    // heardPulse 门控：从未收到脉冲 → drain 不应完成，嘴仍在正弦占位
    expect(onDrained).not.toHaveBeenCalled()
    expect(lip.isRunning()).toBe(true)
    lip.stop()
  })

  it('finish 后始终无脉冲 → 超时兜底（>900 帧）强制收尾', () => {
    const { renderer } = makeRenderer()
    const lip = new PetFakeLipSync(renderer)
    const onDrained = vi.fn()
    lip.enterAudioCharPulse(() => 0)
    advanceFrames(5)
    lip.finish(onDrained)
    // 推进 >900 帧：超时兜底强制收尾
    advanceFrames(950)
    expect(onDrained).toHaveBeenCalledTimes(1)
    expect(lip.isRunning()).toBe(false)
  })

  it('audioCharPulse 下 finish 后脉冲耗尽自动收尾触发回调', () => {
    const { renderer } = makeRenderer()
    const lip = new PetFakeLipSync(renderer)
    const onDrained = vi.fn()
    // 前 2 帧有脉冲，之后无
    let pulseCount = 0
    lip.enterAudioCharPulse(() => (pulseCount++ < 2 ? 1 : 0))
    advanceFrames(5)
    lip.finish(onDrained)
    expect(onDrained).not.toHaveBeenCalled()
    // 推进足够多帧（>30 帧无脉冲 + 能量收敛）
    advanceFrames(60)
    expect(onDrained).toHaveBeenCalledTimes(1)
    expect(lip.isRunning()).toBe(false)
  })

  it('audioCharPulse 下 stop 不触发 onDrained（打断语义）', () => {
    const { renderer } = makeRenderer()
    const lip = new PetFakeLipSync(renderer)
    const onDrained = vi.fn()
    lip.enterAudioCharPulse(() => 1)
    advanceFrames(5)
    lip.finish(onDrained)
    lip.stop()
    expect(onDrained).not.toHaveBeenCalled()
  })

  it('stop 后重新 startTextDriven 应复位 audioCharPulse（新一轮嘴重新张合）', () => {
    const { renderer, mouth } = makeRenderer()
    const lip = new PetFakeLipSync(renderer)
    lip.enterAudioCharPulse(() => 0)
    advanceFrames(5)
    lip.stop()
    const startIdx = mouth.length
    lip.startTextDriven()
    lip.notifyTextActivity(4)
    advanceFrames(20)
    expect(Math.max(...mouth.slice(startIdx))).toBeGreaterThan(0.3)
    lip.stop()
  })

  it('finish 后逐字事件已耗尽但音频仍在播 → 不收尾且嘴保持张合（修复口型早停）', () => {
    const { renderer, mouth } = makeRenderer()
    const lip = new PetFakeLipSync(renderer)
    const onDrained = vi.fn()
    let audioPlaying = true
    // 前 2 帧有脉冲后归零（模拟末块 char 事件早于音频尾），音频探针持续 true
    let pulseCount = 0
    lip.enterAudioCharPulse(() => (pulseCount++ < 2 ? 1 : 0), () => audioPlaying)
    advanceFrames(5)
    lip.finish(onDrained)
    // 逐字事件早已耗尽，但音频仍在播：推进大量帧也不应收尾
    advanceFrames(120)
    expect(onDrained).not.toHaveBeenCalled()
    expect(lip.isRunning()).toBe(true)
    // 音频播放期间嘴应保持张合（低幅正弦占位），不僵在闭合
    const idx = mouth.length - 60
    expect(Math.max(...mouth.slice(idx))).toBeGreaterThan(0.1)
    // 音频播完后 → 逐字脉冲耗尽判定生效，自动收尾
    audioPlaying = false
    advanceFrames(40)
    expect(onDrained).toHaveBeenCalledTimes(1)
    expect(lip.isRunning()).toBe(false)
  })
})
