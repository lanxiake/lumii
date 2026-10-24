import { describe, expect, it } from 'vitest'
import { PauseGate } from './task-pause-gate'

describe('PauseGate', () => {
  it('未暂停时立即放行', async () => {
    const gate = new PauseGate()
    await expect(gate.wait(new AbortController().signal)).resolves.toBeUndefined()
  })

  it('暂停后挂起，恢复后放行', async () => {
    const gate = new PauseGate()
    gate.pause()
    let resumed = false
    const pending = gate.wait(new AbortController().signal).then(() => {
      resumed = true
    })

    await Promise.resolve()
    expect(resumed).toBe(false)

    gate.resume()
    await pending
    expect(resumed).toBe(true)
  })

  it('多个等待者一起放行', async () => {
    const gate = new PauseGate()
    gate.pause()
    const signal = new AbortController().signal
    const all = Promise.all([gate.wait(signal), gate.wait(signal), gate.wait(signal)])
    gate.resume()
    await expect(all).resolves.toHaveLength(3)
  })

  it('挂起期间被中断则 reject（取消不该被暂停卡住）', async () => {
    const gate = new PauseGate()
    const controller = new AbortController()
    gate.pause()
    const pending = gate.wait(controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow('aborted')
  })

  it('已中断的信号在暂停态下直接 reject', async () => {
    const gate = new PauseGate()
    const controller = new AbortController()
    gate.pause()
    controller.abort()
    await expect(gate.wait(controller.signal)).rejects.toThrow('aborted')
  })

  it('重复 resume 是无害的', () => {
    const gate = new PauseGate()
    gate.pause()
    gate.resume()
    gate.resume()
    expect(gate.isPaused).toBe(false)
  })
})
