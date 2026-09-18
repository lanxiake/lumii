/**
 * ONNX 运行时顺序闸的单测
 *
 * 锁的是**状态机契约**，不是崩溃本身——崩溃由
 * `scripts/repro-vad-crash.mjs` / `repro-vad-concurrent.mjs` 在真实原生层复现。
 * 这里保证的是：无论调用顺序如何，**VAD 抢救的机会只有一次，且 E5 永远等它**。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import {
  sherpaFirst,
  sherpaDone,
  waitForSherpa,
  onnxGateState,
  __resetOnnxGateForTest,
} from './onnx-runtime-gate'

describe('onnx-runtime-gate', () => {
  beforeEach(() => __resetOnnxGateForTest())

  it('正常路径：VAD 先抢，E5 后跑', async () => {
    expect(sherpaFirst()).toBe(true)
    expect(onnxGateState().phase).toBe('sherpaHolding')
    sherpaDone()
    await waitForSherpa()
    expect(onnxGateState().phase).toBe('e5Running')
  })

  it('**E5 先跑后 VAD 抢不到**（拒绝而不是硬上——硬上会在原生层崩）', async () => {
    await waitForSherpa()
    expect(sherpaFirst()).toBe(false)
  })

  it('**VAD 初始化中时 E5 挂起**，待 sherpaDone 后放行', async () => {
    sherpaFirst()
    let released = false
    const e5 = waitForSherpa().then(() => {
      released = true
    })
    // 让出事件循环，确认 E5 确实还在等
    await new Promise((r) => setTimeout(r, 10))
    expect(released).toBe(false)
    expect(onnxGateState().pendingE5).toBe(1)

    sherpaDone()
    await e5
    expect(released).toBe(true)
  })

  it('VAD 初始化**失败**也要放行 E5（不能一起拖死）', async () => {
    sherpaFirst()
    const e5 = waitForSherpa()
    sherpaDone() // VAD 抛错的 finally 里调用
    await e5
    expect(onnxGateState().phase).toBe('e5Running')
  })

  it('VAD 已完成后再起 E5：立即放行，不挂起', async () => {
    sherpaFirst()
    sherpaDone()
    const t0 = Date.now()
    await waitForSherpa()
    expect(Date.now() - t0).toBeLessThan(50)
  })

  it('幂等：重复 sherpaFirst 不报错（同一进程可能多次 ensureInitialized）', () => {
    expect(sherpaFirst()).toBe(true)
    expect(sherpaFirst()).toBe(true)
    sherpaDone()
  })
})
