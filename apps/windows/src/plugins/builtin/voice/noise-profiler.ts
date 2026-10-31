/**
 * 环境噪声画像：从麦克风帧能量估算"这是安静房间还是吵地方"，据此微调能量门。
 *
 * 为什么需要：固定的 `energyGateMultiplier` 在安静房间里偏松（一点风扇声就被当语音），
 * 在马路/键盘声环境里偏紧（正常说话被当噪声丢掉）。这里只做粗粒度分档，
 * 给能量门一个 0.7x ~ 1.8x 的修正系数。
 *
 * ponytail: 只用 RMS 分位数，不上谱平坦度/分类模型。上限是"持续人声背景"
 * （电视、咖啡馆聊天）会被误判成 noisy 而不去噪——真需要时再上谱特征。
 */

export type SceneKind = 'quiet' | 'normal' | 'noisy'

/** 打分档位：噪声底越低，能量门越松（更容易触发说话） */
const SCENE_GATE_SCALE: Record<SceneKind, number> = {
  quiet: 0.7,
  normal: 1,
  noisy: 1.8,
}

const WINDOW = 64

export class NoiseProfiler {
  private frames: number[] = []
  private cursor = 0

  /** 推入一帧 RMS（仅静音帧调用，避免用户说话本身被算作噪声底） */
  push(rms: number): void {
    if (!Number.isFinite(rms) || rms < 0) return
    if (this.frames.length < WINDOW) {
      this.frames.push(rms)
      return
    }
    this.frames[this.cursor] = rms
    this.cursor = (this.cursor + 1) % WINDOW
  }

  /** 噪声底（25 分位），样本不足时返回 null */
  floor(): number | null {
    if (this.frames.length < WINDOW / 2) return null
    const sorted = [...this.frames].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length * 0.25)] ?? null
  }

  /** 当前场景分档 */
  scene(): SceneKind {
    const floor = this.floor()
    if (floor === null) return 'normal'
    // 经验阈值：安静房间底噪通常 < 0.004，街头/键盘 < 0.02，再高基本是持续噪声
    if (floor < 0.004) return 'quiet'
    if (floor < 0.02) return 'normal'
    return 'noisy'
  }

  /** 能量门修正系数 */
  gateScale(): number {
    return SCENE_GATE_SCALE[this.scene()]
  }

  reset(): void {
    this.frames = []
    this.cursor = 0
  }
}
