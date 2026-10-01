/** @vitest-environment node */
/**
 * 无头模式（没有主窗口，构造传 null）下的推送路径必须是 no-op。
 *
 * 回归背景（2026-10-01 打包实测发现）：`pushVoiceEvent` 直接 `this.win.isDestroyed()`，
 * 无头里 `this.win` 是 null → 预热（ensureInitialized → emitRuntimeStatus）在 TTS 步骤
 * 以 "Cannot read properties of null" 失败。预热是「非致命」但语音引擎就一直起不来。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp', getAppPath: () => process.cwd() },
}))

import { VoiceCallService } from './voice-service'
import type { VoiceModelManager } from './model-manager'

function stubModelManager(): VoiceModelManager {
  return {
    isTtsReady: () => true,
    getModelPaths: async () => ({ vad: '', asr: '', tts: '' }),
  } as unknown as VoiceModelManager
}

describe('VoiceCallService 窗口为空的推送守卫', () => {
  it('无头（win=null）：ensureTtsInitialized 不因推送空引用失败', async () => {
    const svc = new VoiceCallService(null, async () => {}, stubModelManager())
    await expect(svc.ensureTtsInitialized()).resolves.toBeUndefined()
  })

  it('带窗口：推送照常发出（voice:event）', async () => {
    const send = vi.fn()
    const fakeWin = { isDestroyed: () => false, webContents: { send } } as never
    const svc = new VoiceCallService(fakeWin, async () => {}, stubModelManager())

    await svc.ensureTtsInitialized()

    expect(send).toHaveBeenCalled()
    expect(send.mock.calls.some((c) => c[0] === 'voice:event')).toBe(true)
  })
})
