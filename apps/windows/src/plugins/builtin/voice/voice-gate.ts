/**
 * 能量门：噪声底估计 + 环境画像 + 三档灵敏度。
 *
 * 从 `voice-service.ts` 搬出来的（那儿已经快 2000 行）。这里只做纯判定，
 * 不碰状态机、不碰 ASR——那些留在服务里。
 *
 * ## 为什么灵敏度只动一个系数
 *
 * 计划里原本给三档各配一套 `gateScale`（quiet/normal/noisy 三格 × 三档）。
 * 那样一来「环境自适应」和「用户档位」两层修正会互相掩盖：用户说"灵敏还是没反应"，
 * 分不清是档位不够还是环境被判成了 noisy。现在只保留一层——
 * 档位给一个相对系数，环境画像照旧修正：
 *
 *   speaking 门槛 = 噪声底 × energyGateMultiplier × 档位系数 × 环境系数
 *
 * 标准档系数 1.0，所以默认行为与改动前逐位相同。
 */

import { NoiseProfiler, type SceneKind } from './noise-profiler.js'

export type VoiceSensitivity = 'sensitive' | 'standard' | 'strict'

/** 档位系数：标准 = 1（保持现状），灵敏更松，严格更紧 */
export const SENSITIVITY_SCALE: Record<VoiceSensitivity, number> = {
  sensitive: 0.8,
  standard: 1,
  strict: 1.2,
}

/** 噪声底初值（与改动前一致） */
export const INITIAL_NOISE_BASELINE = 0.01
/** 用前 N 个静音帧做均值估算（约 1s） */
export const NOISE_ESTIMATE_FRAMES = 30

/** 一帧的 RMS 能量 */
export function frameRms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (const s of samples) sum += s * s
  return Math.sqrt(sum / samples.length)
}

export class VoiceGate {
  private baseline = INITIAL_NOISE_BASELINE
  private frameCount = 0
  private readonly profiler = new NoiseProfiler()

  /**
   * 推入一帧**静音**帧的 RMS（调用方负责只在非语音帧调用：
   * 把用户说话算进噪声底会自己抬高门槛）。
   *
   * @param listening 只在 listening 状态下做 EMA 跟随；thinking/speaking 期间的
   *                  静音不该把底噪往别处带。
   */
  pushSilenceFrame(rms: number, listening: boolean): void {
    this.profiler.push(rms)
    if (this.frameCount < NOISE_ESTIMATE_FRAMES) {
      this.baseline = (this.baseline * this.frameCount + rms) / (this.frameCount + 1)
      this.frameCount++
    } else if (listening) {
      this.baseline = this.baseline * 0.95 + rms * 0.05
    }
  }

  noiseBaseline(): number {
    return this.baseline
  }

  scene(): SceneKind {
    return this.profiler.scene()
  }

  /** listening / recognizing 的门槛（绝对能量值） */
  listeningGate(energyGateMultiplier: number, sensitivity: VoiceSensitivity): number {
    const scale = SENSITIVITY_SCALE[sensitivity] ?? 1
    return this.baseline * energyGateMultiplier * scale * this.profiler.gateScale()
  }

  /** speaking 期间判定「是否真的是用户在打断」的门槛 */
  interruptGate(modeMultiplier: number): number {
    return this.baseline * modeMultiplier
  }

  reset(): void {
    this.baseline = INITIAL_NOISE_BASELINE
    this.frameCount = 0
    this.profiler.reset()
  }
}
