/**
 * 采麦约束（`getUserMedia`）。
 *
 * 为什么单独一个文件：通话和唤醒是两条独立采集路径，但必须用同一套约束——
 * 用户在设置里关掉降噪后，唤醒还在偷偷开着降噪，行为就对不上了。
 *
 * ponytail: 改动只在新开流时生效。`MediaStreamTrack.applyConstraints()` 能热改
 * 部分字段，但浏览器对 AGC/NS 的热更支持参差，不如让用户重开一次通话可靠。
 */

import type { VoiceCaptureConfig } from '../../../../shared/voice-events'

export const DEFAULT_CAPTURE: VoiceCaptureConfig = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
}

export function micConstraints(capture: VoiceCaptureConfig): MediaStreamConstraints {
  return {
    audio: {
      channelCount: 1,
      echoCancellation: capture.echoCancellation,
      noiseSuppression: capture.noiseSuppression,
      autoGainControl: capture.autoGainControl,
    },
  }
}

/** 从主进程取当前配置；拿不到就用默认（宁可三开，也别因为取配置失败就采不到音） */
export async function loadCaptureConfig(): Promise<VoiceCaptureConfig> {
  try {
    const api = (window as any).electronAPI?.voice
    if (!api?.sendCommand) return DEFAULT_CAPTURE
    const cfg = await api.sendCommand({ type: 'voice:config:get' })
    return { ...DEFAULT_CAPTURE, ...(cfg?.capture ?? {}) }
  } catch {
    return DEFAULT_CAPTURE
  }
}
