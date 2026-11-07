import { readFileSync } from 'node:fs'

/**
 * 配音与字幕。
 *
 * ## 为什么先有声音、后有时长
 *
 * 现在的做法是「算好秒数 → 按步均分」。人听着别扭：一个 3 秒的句子和一个
 * 15 秒的句子被切成同样长。
 *
 * 正确的顺序是反过来：**先生成每一句的语音、量出真实时长，再让动画跟着语音走**。
 * 这也是 `manim-voiceover`、explainroo、BB-Video 共同的范式——
 * 「先有声音，动画跟着声音走」。
 *
 * ## 为什么字幕和配音绑在一起做
 *
 * 字幕的时间轴就是语音的时间轴。分成两套时间是对不齐的根源（实测过：
 * 手敲的字幕表与旁白差半拍）。这里一份 `Cue[]` 同时产出声、字幕、动画时长。
 */

/** 一句讲解：文字 + 它在这一节里的起止（毫秒） */
export interface Cue {
  /** 这一句讲的是第几步（0 起）——动画按它切换 */
  step: number
  /** 字幕显示的文字（可能与朗读文本不同，如数字写法） */
  text: string
  /** 朗读文本；省略时用 text（数字要念成中文，所以允许分开） */
  say?: string
  startMs: number
  endMs: number
  /** 语音文件绝对路径；没有配音时为空 */
  audioPath?: string
}

export type NarrateIssueKind =
  /** TTS 不可用（没配语音服务、引擎没起来） */
  | 'tts_unavailable'
  /** 某一句合成失败，这一句会静音 */
  | 'segment_failed'
  /** 合成出来是空音频 */
  | 'empty_audio'

export interface NarrateIssue {
  kind: NarrateIssueKind
  step: number
  detail: string
}

export interface NarrateDeps {
  /** 客户端 TTS：写出音频文件并返回绝对路径 */
  generateAudioFile: (text: string, destDir: string) => Promise<string>
  /** 读音频时长（毫秒） */
  probeDurationMs: (filePath: string) => Promise<number | null>
  log: (msg: string) => void
}

export interface NarrateResult {
  ok: boolean
  cues: Cue[]
  issues: NarrateIssue[]
  /** 全部语音拼起来的时长（含句间停顿） */
  totalMs: number
}

/** 句与句之间的停顿：太紧听起来像背书，太长显得断续 */
const GAP_MS = 320

/**
 * 把一节里的每行讲义变成一句讲解，逐句合成语音并量出真实时长。
 *
 * 失败**不阻断**：哪一句合成失败就记一条 issue、时长按字数估，其余照常。
 * 整条视频因为一句话的 TTS 挂掉而不出片，是比静音更糟的结果。
 */
export async function narrateSection(
  opts: {
    /** 每步要讲的话，下标即步号 */
    lines: string[]
    destDir: string
  },
  deps: NarrateDeps,
): Promise<NarrateResult> {
  const cues: Cue[] = []
  const issues: NarrateIssue[] = []
  let cursor = 0

  for (let step = 0; step < opts.lines.length; step++) {
    const text = opts.lines[step]?.trim()
    if (!text) continue

    let durationMs: number | null = null
    let audioPath: string | undefined
    try {
      audioPath = await deps.generateAudioFile(text, opts.destDir)
      durationMs = await deps.probeDurationMs(audioPath)
      if (durationMs !== null && durationMs < 120) {
        issues.push({ kind: 'empty_audio', step, detail: `第 ${step + 1} 句合成出来几乎是空的（${durationMs}ms）` })
        durationMs = null
      }
    } catch (err) {
      issues.push({
        kind: 'segment_failed',
        step,
        detail: `第 ${step + 1} 句配音失败：${err instanceof Error ? err.message : String(err)}`,
      })
    }

    // 合成不出来就按字数估：中文约 4.5 字/秒
    if (durationMs === null) {
      durationMs = Math.max(1200, Math.round((text.length / 4.5) * 1000))
      audioPath = undefined
    }

    cues.push({
      step,
      text,
      startMs: cursor,
      endMs: cursor + durationMs,
      ...(audioPath ? { audioPath } : {}),
    })
    cursor += durationMs + GAP_MS
  }

  // 最后一句后面不留停顿
  const last = cues[cues.length - 1]
  const totalMs = last ? last.endMs : 0

  if (cues.length === 0) {
    issues.push({ kind: 'tts_unavailable', step: 0, detail: '这一节没有可朗读的讲义' })
    return { ok: false, cues, issues, totalMs: 0 }
  }
  return { ok: true, cues, issues, totalMs }
}

/** 读 WAV 头拿时长（与 screen-record 的 probeMediaDurationMs 同口径，但只认 WAV） */
export function probeWavDurationMs(buf: Buffer): number | null {
  if (buf.length < 44) return null
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
  const byteRate = buf.readUInt32LE(28)
  if (byteRate <= 0) return null
  const dataBytes = Math.max(0, buf.length - 44)
  return Math.round((dataBytes / byteRate) * 1000)
}

/**
 * 探测任意媒体时长。
 *
 * TTS 输出可能是 mp3 也可能是 wav，所以不能只认 WAV 头；mp3 走 ffmpeg 的
 * `Duration:` 输出。解析失败返回 null（调用方降级为按字数估时长）。
 */
export async function probeMediaDurationMs(
  filePath: string,
  ffmpeg: { resolve: () => Promise<string | null>; run: (a: readonly string[], o?: { timeoutMs?: number }) => Promise<{ ok: boolean; stderr: string }> },
): Promise<number | null> {
  // WAV 直接读头，比起一个 ffmpeg 进程快一个数量级
  try {
    const buf = readFileSync(filePath)
    const wavMs = probeWavDurationMs(buf)
    if (wavMs !== null && wavMs > 0) return wavMs
    // 不是 WAV（多半是 mp3）→ 继续往下走 ffmpeg，**不要在这里 return null**
    // （初版就是在这里提前返回，导致所有 mp3 都探测失败、时长按字数估成十几分钟）
  } catch {
    return null
  }
  if (await ffmpeg.resolve().catch(() => null)) {
    // ffmpeg -i 无输出文件时返回非零，但 stderr 里有 Duration
    const r = await ffmpeg.run(['-i', filePath], { timeoutMs: 15_000 }).catch(() => null)
    const m = r ? /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(r.stderr) : null
    if (m) {
      const [, h, mi, s] = m
      return Math.round((Number(h) * 3600 + Number(mi) * 60 + Number(s)) * 1000)
    }
  }
  return null
}

/** SRT 时间戳：`00:01:23,456` */
export function srtTime(ms: number): string {
  const total = Math.max(0, Math.round(ms))
  const h = Math.floor(total / 3_600_000)
  const m = Math.floor((total % 3_600_000) / 60_000)
  const s = Math.floor((total % 60_000) / 1000)
  const msPart = total % 1000
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(msPart, 3)}`
}

/**
 * 生成 SRT 字幕。
 *
 * `offsetMs` 是这一节在整条视频里的起点——合成后每节字幕要接在一起，
 * 时间戳必须是全局的，不是节内的。
 */
export function cuesToSrt(cues: readonly Cue[], offsetMs = 0): string {
  return cues
    .map((c, i) => `${i + 1}\n${srtTime(c.startMs + offsetMs)} --> ${srtTime(c.endMs + offsetMs)}\n${c.text}\n`)
    .join('\n')
}

/**
 * 按真实语音时长重新分配每一步的时长。
 *
 * 这一步是把「配音」和「动画」缝在一起的地方：`sectionSeconds` 现在由
 * 语音决定，不再由「每步 3 秒」这种拍脑袋的常数决定。
 */
export function stepDurationsFromCues(cues: readonly Cue[], stepCount: number): number[] {
  const out: number[] = new Array(stepCount).fill(0)
  for (const c of cues) {
    if (c.step < 0 || c.step >= stepCount) continue
    out[c.step] = (out[c.step] ?? 0) + (c.endMs - c.startMs)
  }
  // 没有语音的步给一个兜底，避免 0 秒（画面一闪而过）
  for (let i = 0; i < stepCount; i++) {
    if ((out[i] ?? 0) < 800) out[i] = 2200
  }
  return out
}
