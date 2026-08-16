/**
 * 录屏旁白编排：TTS → SRT → ffmpeg 混音 / 默认烧字幕
 */
import fs from 'node:fs'
import path from 'node:path'
import type {
  ScreenRecordAnnotation,
  ScreenRecordConfig,
  ScreenRecordNarrateParams,
  ScreenRecordNarrateResult,
} from '../../shared/screen-record'
import { SCREEN_RECORD_SETTINGS_DEFAULTS } from '../../shared/screen-record'
import { isPathUnderDir } from '../preview-path-acl'
import { probeMediaDurationMs } from './audio-duration'
import { runFfmpeg, webmToMp4, type FfmpegRunResult } from './ffmpeg-runner'
import { cuesToSrt } from './srt'
import {
  buildProjectPaths,
  ensureOriginalBackup,
  migrateLegacySidecar,
  persistResolvedCuesAsProject,
  resolveOriginalVideoPath,
} from './subtitle-project'
import { buildSubtitleForceStyle } from './subtitle-style'

/** narrate 依赖注入 */
export interface NarrateServiceDeps {
  resolveRecordingsDir: () => string
  readSettings: () => Promise<
    Pick<ScreenRecordConfig, 'enabled' | 'narrateOriginalAudioGain' | 'exportMp4Default'>
  >
  /** 客户端 TTS：写出音频文件并返回绝对路径 */
  generateAudioFile?: (text: string, destDir: string) => Promise<string>
  probeDurationMs?: (filePath: string) => Promise<number | null>
  runFfmpeg?: (args: string[], opts?: { cwd?: string }) => Promise<FfmpegRunResult>
  convertWebmToMp4?: (input: string, output: string) => Promise<FfmpegRunResult>
  resolveTempDir?: () => string
}

/**
 * 转义 ffmpeg subtitles 滤镜路径（Windows 盘符与反斜杠）。
 */
export function escapeFfmpegSubtitlesPath(absPath: string): string {
  return absPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

/**
 * 候选中文字体路径（烧字幕用）。
 */
export function resolveBurnFontPath(): string | null {
  const candidates = [
    'C:\\Windows\\Fonts\\msyh.ttc',
    'C:\\Windows\\Fonts\\msyh.ttf',
    'C:\\Windows\\Fonts\\simhei.ttf',
    'C:\\Windows\\Fonts\\simsun.ttc',
    'C:\\Windows\\Fonts\\arial.ttf',
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return null
}

/**
 * 转义 drawtext 文本中的特殊字符。
 */
export function escapeFfmpegDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
}

/**
 * 将 timeline annotation 烧录为中间视频（drawbox/drawtext）。
 * 失败时回退到源路径并带 warning，不阻塞后续字幕配音。
 */
export async function preBurnAnnotations(
  srcPath: string,
  annotations: ScreenRecordAnnotation[],
  opts: {
    tempDir: string
    runFfmpeg: (args: string[]) => Promise<FfmpegRunResult>
  },
): Promise<{ outputPath: string; warnings: string[] }> {
  if (!annotations.length) return { outputPath: srcPath, warnings: [] }

  const warnings: string[] = []
  const font = resolveBurnFontPath()
  const filters: string[] = []
  const vw = 10000
  const vh = 10000

  for (const a of annotations) {
    const start = Math.max(0, a.atMs) / 1000
    const end = Math.max(a.atMs + 1, a.endMs || a.atMs + 5000) / 1000
    const enable = `enable='between(t,${start},${end})'`
    const xExpr = `(w*${a.geometry.x})/${vw}`
    const yExpr = `(h*${a.geometry.y})/${vh}`
    const wExpr = a.geometry.w != null ? `(w*${a.geometry.w})/${vw}` : `(w*800)/${vw}`
    const hExpr = a.geometry.h != null ? `(h*${a.geometry.h})/${vh}` : `(h*800)/${vh}`
    const color = (a.style?.color ?? '0xFFFF00').replace('#', '0x')
    const thick = Math.max(2, Math.round(((a.style?.thickness ?? 120) * 480) / 10000))

    if (a.kind === 'rect' || a.kind === 'circle') {
      filters.push(
        `drawbox=x=${xExpr}:y=${yExpr}:w=${wExpr}:h=${hExpr}:color=${color}:t=${thick}:${enable}`,
      )
    }

    const text = a.kind === 'text' ? a.text || a.label : a.label
    if (text) {
      if (!font) {
        warnings.push('annotation_font_missing_text_skipped')
      } else {
        const fontSize = Math.max(12, Math.round(((a.style?.fontSize ?? 320) * 480) / 10000))
        filters.push(
          `drawtext=fontfile='${escapeFfmpegSubtitlesPath(font)}':fontcolor=${color}:fontsize=${fontSize}:x=${xExpr}:y=${yExpr}:text='${escapeFfmpegDrawtext(text)}':${enable}`,
        )
      }
    }
  }

  if (filters.length === 0) return { outputPath: srcPath, warnings }

  const ext = path.extname(srcPath) || '.webm'
  const outputPath = path.join(opts.tempDir, `annotated${ext}`)
  const result = await opts.runFfmpeg([
    '-y',
    '-i',
    srcPath,
    '-vf',
    filters.join(','),
    '-c:a',
    'copy',
    outputPath,
  ])
  if (!result.ok) {
    warnings.push('annotation_burn_failed')
    return { outputPath: srcPath, warnings }
  }
  return { outputPath, warnings }
}

/**
 * 按输出容器选择音频编码器。
 *
 * 混音时视频走 `-c:v copy`，所以中间文件必须保持与源相同的容器：
 * WebM 只接受 Vorbis/Opus，MP4 中 H.264 需配 AAC，选错会在写头时直接失败。
 */
export function resolveAudioCodecForContainer(outputPath: string): string {
  return path.extname(outputPath).toLowerCase() === '.webm' ? 'libopus' : 'aac'
}

/**
 * 构造旁白混音 ffmpeg 参数（含原声压低）。
 *
 * 新策略：使用 overlay audio 方式逐段叠加，确保 TTS 不重叠。
 * 每段 TTS 只在指定时间窗口内播放，超出部分自动截断。
 */
export function buildDubFilterArgs(
  sourcePath: string,
  cues: Array<{ startMs: number; endMs: number; audioPath: string }>,
  gain: number,
  outputPath: string,
): string[] {
  const args: string[] = ['-y', '-i', sourcePath]
  for (const c of cues) args.push('-i', c.audioPath)

  const filters: string[] = []

  // 压低原声
  let prevLabel = '[0:a]'
  if (gain < 1.0) {
    filters.push(`[0:a]volume=${gain}[a0]`)
    prevLabel = '[a0]'
  }

  // 逐段叠加 TTS，每段限制播放时长避免重叠
  cues.forEach((c, idx) => {
    const inIdx = idx + 1
    const durationSec = (c.endMs - c.startMs) / 1000
    const delaySec = c.startMs / 1000

    // 截断音频到指定时长，避免超出时间窗口
    const trimmed = `trim${idx}`
    filters.push(`[${inIdx}:a]atrim=0:${durationSec},asetpts=PTS-STARTPTS[${trimmed}]`)

    // 延迟后叠加到主轨道
    const delayed = `d${idx}`
    filters.push(`[${trimmed}]adelay=${Math.round(delaySec * 1000)}|${Math.round(delaySec * 1000)}[${delayed}]`)

    // 与前一轨道混合
    const outLabel = idx === cues.length - 1 ? '[aout]' : `[mix${idx}]`
    filters.push(`${prevLabel}[${delayed}]amix=inputs=2:duration=first[${outLabel.slice(1, -1)}]`)
    prevLabel = outLabel
  })

  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    '0:v',
    '-map',
    '[aout]',
    '-c:v',
    'copy',
    '-c:a',
    resolveAudioCodecForContainer(outputPath),
    outputPath,
  )
  return args
}

/**
 * 无原声时：仅旁白轨混入（duration=longest）。
 *
 * 新策略：同样使用 overlay 逐段叠加，确保不重叠。
 */
export function buildDubOnlyFilterArgs(
  sourcePath: string,
  cues: Array<{ startMs: number; endMs: number; audioPath: string }>,
  outputPath: string,
): string[] {
  const args: string[] = ['-y', '-i', sourcePath]
  for (const c of cues) args.push('-i', c.audioPath)

  if (cues.length === 0) {
    // 无旁白，直接复制
    args.push('-c:v', 'copy', '-c:a', 'copy', outputPath)
    return args
  }

  const filters: string[] = []
  let prevLabel: string | null = null

  // 第一段：作为基础轨道
  const firstCue = cues[0]!
  const dur0 = (firstCue.endMs - firstCue.startMs) / 1000
  const delay0 = firstCue.startMs / 1000
  filters.push(`[1:a]atrim=0:${dur0},asetpts=PTS-STARTPTS,adelay=${Math.round(delay0 * 1000)}|${Math.round(delay0 * 1000)}[base]`)
  prevLabel = '[base]'

  // 后续段：逐个叠加
  for (let i = 1; i < cues.length; i++) {
    const c = cues[i]!
    const inIdx = i + 1
    const durationSec = (c.endMs - c.startMs) / 1000
    const delaySec = c.startMs / 1000

    const trimmed = `trim${i}`
    filters.push(`[${inIdx}:a]atrim=0:${durationSec},asetpts=PTS-STARTPTS[${trimmed}]`)

    const delayed = `d${i}`
    filters.push(`[${trimmed}]adelay=${Math.round(delaySec * 1000)}|${Math.round(delaySec * 1000)}[${delayed}]`)

    const outLabel = i === cues.length - 1 ? '[aout]' : `[mix${i}]`
    filters.push(`${prevLabel}[${delayed}]amix=inputs=2:duration=first[${outLabel.slice(1, -1)}]`)
    prevLabel = outLabel
  }

  args.push(
    '-filter_complex',
    filters.join(';'),
    '-map',
    '0:v',
    '-map',
    prevLabel,
    '-c:v',
    'copy',
    '-c:a',
    resolveAudioCodecForContainer(outputPath),
    '-shortest',
    outputPath,
  )
  return args
}

/**
 * 创建旁白服务。
 */
export function createNarrateService(deps: NarrateServiceDeps) {
  const probe = deps.probeDurationMs ?? probeMediaDurationMs
  const ffmpeg = deps.runFfmpeg ?? runFfmpeg
  const toMp4 = deps.convertWebmToMp4 ?? webmToMp4

  /**
   * 执行旁白管线。
   */
  async function narrate(params: ScreenRecordNarrateParams): Promise<ScreenRecordNarrateResult> {
    const settings = await deps.readSettings()
    if (!settings.enabled) {
      return { ok: false, error: 'disabled' }
    }

    if (!params?.path || typeof params.path !== 'string') {
      return { ok: false, error: 'invalid_cues', message: 'path required' }
    }
    if (!Array.isArray(params.cues) || params.cues.length === 0) {
      return { ok: false, error: 'invalid_cues', message: 'cues required' }
    }
    for (const c of params.cues) {
      if (
        typeof c.startMs !== 'number' ||
        c.startMs < 0 ||
        typeof c.text !== 'string' ||
        !c.text.trim()
      ) {
        return {
          ok: false,
          error: 'invalid_cues',
          message: 'each cue needs startMs>=0 and non-empty text',
        }
      }
    }

    const sourceAbs = path.resolve(params.path)
    const recordingsDir = path.resolve(deps.resolveRecordingsDir())
    if (!isPathUnderDir(sourceAbs, recordingsDir)) {
      return { ok: false, error: 'source_not_in_recordings' }
    }
    if (!fs.existsSync(sourceAbs)) {
      return { ok: false, error: 'source_unavailable', message: 'source file missing' }
    }

    const writeSrt = params.writeSrt !== false
    const dub = params.dub !== false
    const subtitleMode = params.subtitleMode ?? 'burn'
    const gain =
      typeof params.originalAudioGain === 'number'
        ? Math.min(1, Math.max(0, params.originalAudioGain))
        : (settings.narrateOriginalAudioGain ??
          SCREEN_RECORD_SETTINGS_DEFAULTS.narrateOriginalAudioGain)

    const tempDir =
      deps.resolveTempDir?.() ?? path.join(recordingsDir, '_narrate_tmp', String(Date.now()))
    fs.mkdirSync(tempDir, { recursive: true })

    const resolvedCues: Array<{
      startMs: number
      endMs: number
      text: string
      audioPath?: string
    }> = []

    const actualDurations = new Map<string, number>() // audioPath -> durationMs

    try {
      for (let i = 0; i < params.cues.length; i++) {
        const cue = params.cues[i]!
        const text = cue.text.trim()
        let endMs = cue.endMs
        let audioPath: string | undefined

        if (dub) {
          if (!deps.generateAudioFile) {
            return { ok: false, error: 'tts_unavailable', message: 'TTS not wired' }
          }
          try {
            audioPath = await deps.generateAudioFile(text, tempDir)
          } catch (e) {
            return {
              ok: false,
              error: 'tts_unavailable',
              message: e instanceof Error ? e.message : String(e),
            }
          }
          // 探测 TTS 实际时长
          const actualDur = (await probe(audioPath)) ?? 1500
          actualDurations.set(audioPath, actualDur)

          if (endMs == null || endMs <= cue.startMs) {
            endMs = cue.startMs + Math.max(200, actualDur)
          }
        } else if (endMs == null || endMs <= cue.startMs) {
          endMs = cue.startMs + Math.max(800, Math.round((text.length / 4) * 1000))
        }

        // 检测与下一段冲突，自动调整避免TTS重叠
        const nextCue = params.cues[i + 1]
        if (nextCue && endMs > nextCue.startMs) {
          // 压缩当前段到下一段前留200ms缓冲
          const adjusted = nextCue.startMs - 200
          if (adjusted > cue.startMs) {
            endMs = adjusted
          }
        }

        resolvedCues.push({ startMs: cue.startMs, endMs: endMs!, text, audioPath })
      }

      const projectPaths = migrateLegacySidecar(sourceAbs)
      let srtPath: string | undefined
      if (writeSrt) {
        fs.mkdirSync(projectPaths.assetDir, { recursive: true })
        srtPath = projectPaths.srtPath
        fs.writeFileSync(srtPath, cuesToSrt(resolvedCues), 'utf8')
      }

      // 始终以无字幕原片为输入：成片会被就地覆盖，否则重复配音会字幕叠字幕
      const originalVideo = ensureOriginalBackup(sourceAbs)
      // 中间产物沿用源容器：视频走 copy，容器换成 .webm 会让 H.264 写头失败
      const containerExt = path.extname(originalVideo).toLowerCase() || '.webm'
      const wantMp4 = params.exportMp4 === true
      const outPath = path.join(
        projectPaths.dir,
        `${projectPaths.stem}${wantMp4 ? '.mp4' : containerExt}`,
      )
      let warning:
        | 'subtitle_burn_failed'
        | 'mp4_failed'
        | 'annotation_burn_failed'
        | 'annotation_font_missing_text_skipped'
        | undefined
      let workingVideo = originalVideo
      let dubbedOk = false

      // 先烧 annotation（若有），再配音/字幕
      if (Array.isArray(params.annotations) && params.annotations.length > 0) {
        const burnedAnno = await preBurnAnnotations(workingVideo, params.annotations, {
          tempDir,
          runFfmpeg: ffmpeg,
        })
        workingVideo = burnedAnno.outputPath
        if (burnedAnno.warnings.includes('annotation_burn_failed')) {
          warning = 'annotation_burn_failed'
        } else if (burnedAnno.warnings.includes('annotation_font_missing_text_skipped')) {
          warning = 'annotation_font_missing_text_skipped'
        }
      }

      if (dub) {
        const audioCues = resolvedCues
          .filter((c): c is typeof c & { audioPath: string } => !!c.audioPath)
          .map((c) => ({ startMs: c.startMs, endMs: c.endMs, audioPath: c.audioPath }))
        const mixedPath = path.join(tempDir, `mixed${containerExt}`)
        let mixResult = await ffmpeg(buildDubFilterArgs(originalVideo, audioCues, gain, mixedPath))
        if (!mixResult.ok) {
          mixResult = await ffmpeg(buildDubOnlyFilterArgs(originalVideo, audioCues, mixedPath))
        }
        if (!mixResult.ok) {
          return { ok: false, error: 'narrate_failed', message: mixResult.message }
        }
        workingVideo = mixedPath
        dubbedOk = true
      }

      let burnedOk = false
      if (writeSrt && srtPath && subtitleMode === 'burn') {
        const font = resolveBurnFontPath()
        const esc = escapeFfmpegSubtitlesPath(srtPath)
        const forceStyle = buildSubtitleForceStyle(undefined)
        const fontOpt = font
          ? `:fontsdir='${escapeFfmpegSubtitlesPath(path.dirname(font))}':force_style='${forceStyle}'`
          : `:force_style='${forceStyle}'`
        const burned = path.join(tempDir, `burned${containerExt}`)
        const burnResult = await ffmpeg([
          '-y',
          '-i',
          workingVideo,
          '-vf',
          `subtitles='${esc}'${fontOpt}`,
          '-c:a',
          'copy',
          burned,
        ])
        if (burnResult.ok) {
          workingVideo = burned
          burnedOk = true
        } else {
          warning = 'subtitle_burn_failed'
        }
      }

      // 覆盖前先转成目标容器，失败则退回源容器，避免留下半成品
      let finalPath = outPath
      if (wantMp4 && containerExt !== '.mp4') {
        const mp4Temp = path.join(tempDir, 'final.mp4')
        const r = await toMp4(workingVideo, mp4Temp)
        if (r.ok) {
          workingVideo = mp4Temp
        } else {
          if (!warning) warning = 'mp4_failed'
          finalPath = path.join(projectPaths.dir, `${projectPaths.stem}${containerExt}`)
        }
      }

      fs.copyFileSync(workingVideo, finalPath)
      // 容器变化时旧成片改名了，清掉它，列表里始终只留一个视频
      if (path.resolve(finalPath) !== sourceAbs && fs.existsSync(sourceAbs)) {
        fs.rmSync(sourceAbs, { force: true })
      }

      // 写入可编辑 sidecar，便于 UI 续改
      try {
        persistResolvedCuesAsProject(finalPath, resolvedCues)
      } catch {
        // 旁白成片已产出，sidecar 失败不阻断
      }

      const finalPaths = buildProjectPaths(finalPath)
      let bytes = 0
      try {
        bytes = fs.statSync(finalPath).size
      } catch {
        bytes = 0
      }
      const durationMs = (await probe(finalPath)) ?? undefined
      const ttsCount = resolvedCues.filter((c) => !!c.audioPath).length
      const originalPath = resolveOriginalVideoPath(finalPath) ?? undefined

      return {
        ok: true,
        path: finalPath,
        originalPath,
        projectDir: finalPaths.assetDir,
        srtPath,
        mp4Path: path.extname(finalPath).toLowerCase() === '.mp4' ? finalPath : undefined,
        warning,
        bytes,
        durationMs,
        dubbed: dubbedOk,
        burned: burnedOk,
        ttsCount,
        message:
          '成片已就地更新；原片备份在 *.lumii-subs/original.*；勿再查找 *-narrated / *-burned 文件',
      }
    } catch (e) {
      return {
        ok: false,
        error: 'narrate_failed',
        message: e instanceof Error ? e.message : String(e),
      }
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  }

  return { narrate }
}

export type NarrateService = ReturnType<typeof createNarrateService>
