/**
 * 录屏旁白编排：TTS → SRT → ffmpeg 混音 / 默认烧字幕
 */
import fs from 'node:fs'
import path from 'node:path'
import type {
  ScreenRecordConfig,
  ScreenRecordNarrateParams,
  ScreenRecordNarrateResult,
} from '../../shared/screen-record'
import { SCREEN_RECORD_SETTINGS_DEFAULTS } from '../../shared/screen-record'
import { isPathUnderDir } from '../preview-path-acl'
import { probeMediaDurationMs } from './audio-duration'
import { runFfmpeg, webmToMp4, type FfmpegRunResult } from './ffmpeg-runner'
import { cuesToSrt } from './srt'

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
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return null
}

/**
 * 生成旁白输出文件名：foo.webm → foo-narrated.webm
 */
export function buildNarratedOutputPath(sourcePath: string): string {
  const dir = path.dirname(sourcePath)
  const ext = path.extname(sourcePath) || '.webm'
  const base = path.basename(sourcePath, ext)
  return path.join(dir, `${base}-narrated${ext}`)
}

/**
 * 构造旁白混音 ffmpeg 参数（含原声压低）。
 */
export function buildDubFilterArgs(
  sourcePath: string,
  cues: Array<{ startMs: number; audioPath: string }>,
  gain: number,
  outputPath: string,
): string[] {
  const args: string[] = ['-y', '-i', sourcePath]
  for (const c of cues) args.push('-i', c.audioPath)

  const filters: string[] = [`[0:a]volume=${gain}[a0]`]
  const mixLabels = ['[a0]']
  cues.forEach((c, idx) => {
    const inIdx = idx + 1
    const label = `d${idx}`
    const delay = Math.max(0, Math.round(c.startMs))
    filters.push(`[${inIdx}:a]adelay=${delay}|${delay}[${label}]`)
    mixLabels.push(`[${label}]`)
  })
  filters.push(
    `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0[aout]`,
  )

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
    'libopus',
    outputPath,
  )
  return args
}

/**
 * 无原声时：仅旁白轨混入（duration=longest）。
 */
export function buildDubOnlyFilterArgs(
  sourcePath: string,
  cues: Array<{ startMs: number; audioPath: string }>,
  outputPath: string,
): string[] {
  const args: string[] = ['-y', '-i', sourcePath]
  for (const c of cues) args.push('-i', c.audioPath)

  const mixFilters = cues.map((c, idx) => {
    const inIdx = idx + 1
    const label = `d${idx}`
    const delay = Math.max(0, Math.round(c.startMs))
    return `[${inIdx}:a]adelay=${delay}|${delay}[${label}]`
  })
  const mixLabels = cues.map((_, idx) => `[d${idx}]`)
  const fc =
    mixFilters.join(';') +
    ';' +
    `${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:dropout_transition=0[aout]`

  args.push(
    '-filter_complex',
    fc,
    '-map',
    '0:v',
    '-map',
    '[aout]',
    '-c:v',
    'copy',
    '-c:a',
    'libopus',
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

    try {
      for (const cue of params.cues) {
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
          if (endMs == null || endMs <= cue.startMs) {
            const dur = (await probe(audioPath)) ?? 1500
            endMs = cue.startMs + Math.max(200, dur)
          }
        } else if (endMs == null || endMs <= cue.startMs) {
          endMs = cue.startMs + Math.max(800, Math.round((text.length / 4) * 1000))
        }

        resolvedCues.push({ startMs: cue.startMs, endMs: endMs!, text, audioPath })
      }

      let srtPath: string | undefined
      if (writeSrt) {
        srtPath = sourceAbs.replace(/\.[^.]+$/i, '') + '-narrated.srt'
        fs.writeFileSync(srtPath, cuesToSrt(resolvedCues), 'utf8')
      }

      const outPath = buildNarratedOutputPath(sourceAbs)
      let warning: 'subtitle_burn_failed' | 'mp4_failed' | undefined
      let workingVideo = sourceAbs

      if (dub) {
        const audioCues = resolvedCues
          .filter((c): c is typeof c & { audioPath: string } => !!c.audioPath)
          .map((c) => ({ startMs: c.startMs, audioPath: c.audioPath }))
        const mixedPath = path.join(tempDir, 'mixed.webm')
        let mixResult = await ffmpeg(buildDubFilterArgs(sourceAbs, audioCues, gain, mixedPath))
        if (!mixResult.ok) {
          mixResult = await ffmpeg(buildDubOnlyFilterArgs(sourceAbs, audioCues, mixedPath))
        }
        if (!mixResult.ok) {
          return { ok: false, error: 'narrate_failed', message: mixResult.message }
        }
        workingVideo = mixedPath
      }

      if (writeSrt && srtPath && subtitleMode === 'burn') {
        const font = resolveBurnFontPath()
        const esc = escapeFfmpegSubtitlesPath(srtPath)
        const fontOpt = font
          ? `:fontsdir='${escapeFfmpegSubtitlesPath(path.dirname(font))}':force_style='FontName=Microsoft YaHei'`
          : `:force_style='FontName=Microsoft YaHei'`
        const burned = path.join(tempDir, 'burned.webm')
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
          fs.copyFileSync(burned, outPath)
        } else {
          warning = 'subtitle_burn_failed'
          fs.copyFileSync(workingVideo, outPath)
        }
      } else {
        fs.copyFileSync(workingVideo, outPath)
      }

      let mp4Path: string | undefined
      if (params.exportMp4 === true) {
        const mp4Out = outPath.replace(/\.webm$/i, '.mp4')
        const r = await toMp4(outPath, mp4Out)
        if (r.ok) mp4Path = mp4Out
        else if (!warning) warning = 'mp4_failed'
      }

      return { ok: true, path: outPath, srtPath, mp4Path, warning }
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
