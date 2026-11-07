/**
 * boot-audio — 开机音效，全部用 WebAudio 现场合成，不引入任何音频文件。
 *
 * 三件套：
 * - 底座：两个微失谐的低频正弦 + 低通噪声，窄带扫频，出「引擎启动」的空间感
 * - 脉冲：每推进一个阶段叠一个短促的高频点音，给进度以听觉反馈
 * - 收尾：主壳就绪时一个上行三和音，然后整体淡出
 *
 * 音量刻意压得很低（母增益 0.06 ≈ −24dB）：开机音效是氛围，不该在会议室里
 * 突然把人吓一跳。用户可在设置里彻底关掉。
 *
 * 所有节点挂在同一个 GainNode 下，`stop()` 只需淡出母增益再断开，避免漏音。
 */

/** 母增益：0.06 约等于 −24dB，是「能听见但不打扰」的经验值 */
const MASTER_GAIN = 0.06

export interface BootAudioHandle {
  /** 进度推进时调用；同一阶段重复调用由调用方去重 */
  pulse: () => void
  /** 主壳就绪：上行和音 + 淡出 */
  finish: () => Promise<void>
  /** 立即静音并释放 */
  stop: () => void
}

/**
 * 创建音效引擎。浏览器不支持 WebAudio 时返回 no-op，绝不抛错——
 * 开机动画不能因为没声音就崩。
 */
export function createBootAudio(): BootAudioHandle {
  const Ctx =
    typeof window !== 'undefined'
      ? window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined

  if (!Ctx) {
    return { pulse: () => undefined, finish: async () => undefined, stop: () => undefined }
  }

  let ctx: AudioContext
  try {
    ctx = new Ctx()
  } catch {
    return { pulse: () => undefined, finish: async () => undefined, stop: () => undefined }
  }

  const master = ctx.createGain()
  master.gain.value = 0
  master.connect(ctx.destination)
  // 缓入 900ms：从无声到母增益，避免起播那一下「啪」的爆音
  master.gain.linearRampToValueAtTime(MASTER_GAIN, ctx.currentTime + 0.9)

  const sources: AudioScheduledSourceNode[] = []

  /** 底座：双低频 + 噪声，随进度缓慢升调 */
  const startDrone = () => {
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 420
    filter.Q.value = 1.2
    filter.connect(master)

    for (const [freq, detune] of [
      [55, -6],
      [82.5, 7],
    ] as const) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = freq
      osc.detune.value = detune
      const g = ctx.createGain()
      g.gain.value = 0.35
      osc.connect(g).connect(filter)
      osc.start()
      sources.push(osc)
    }

    // 噪声：2 秒循环的粉噪缓冲，经带通做出气流感
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    let last = 0
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1
      last = (last + 0.02 * white) / 1.02
      data[i] = last * 3.2
    }
    const noise = ctx.createBufferSource()
    noise.buffer = buffer
    noise.loop = true
    const noiseFilter = ctx.createBiquadFilter()
    noiseFilter.type = 'bandpass'
    noiseFilter.frequency.value = 700
    noiseFilter.Q.value = 0.8
    const noiseGain = ctx.createGain()
    noiseGain.gain.value = 0.22
    noise.connect(noiseFilter).connect(noiseGain).connect(master)
    noise.start()
    sources.push(noise)

    // 扫频：12 秒内把低通从 420Hz 拉到 1.6kHz，制造「系统在升温」的推进感
    filter.frequency.linearRampToValueAtTime(1600, ctx.currentTime + 12)
  }

  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
  startDrone()

  return {
    pulse() {
      if (ctx.state === 'closed') return
      const now = ctx.currentTime
      const osc = ctx.createOscillator()
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(1180, now)
      osc.frequency.exponentialRampToValueAtTime(1760, now + 0.06)
      const g = ctx.createGain()
      // 极短包络：6ms 起、120ms 衰完，听感是「嘀」而不是「嗡」
      g.gain.setValueAtTime(0, now)
      g.gain.linearRampToValueAtTime(0.32, now + 0.006)
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.12)
      osc.connect(g).connect(master)
      osc.start(now)
      osc.stop(now + 0.14)
    },

    async finish() {
      if (ctx.state === 'closed') return
      const now = ctx.currentTime
      // 上行三和音：A4 → C#5 → E5，各错开 70ms，收成一个大三和弦
      for (const [i, freq] of [440, 554.37, 659.25].entries()) {
        const t0 = now + i * 0.07
        const osc = ctx.createOscillator()
        osc.type = 'sine'
        osc.frequency.value = freq
        const g = ctx.createGain()
        g.gain.setValueAtTime(0, t0)
        g.gain.linearRampToValueAtTime(0.26, t0 + 0.05)
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.75)
        osc.connect(g).connect(master)
        osc.start(t0)
        osc.stop(t0 + 0.8)
      }
      // 母增益在 550ms 内淡到 0，与视觉淡出对齐
      master.gain.cancelScheduledValues(ctx.currentTime)
      master.gain.setValueAtTime(master.gain.value, ctx.currentTime)
      master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.55)
      await new Promise<void>((r) => window.setTimeout(r, 600))
      this.stop()
    },

    stop() {
      try {
        master.gain.cancelScheduledValues(ctx.currentTime)
        master.gain.setValueAtTime(0, ctx.currentTime)
      } catch {
        // ignore
      }
      for (const s of sources) {
        try {
          s.stop()
        } catch {
          // 已停止
        }
      }
      sources.length = 0
      void ctx.close().catch(() => undefined)
    },
  }
}
