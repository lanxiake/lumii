/**
 * 字幕烧录编排：增量 TTS → 保存 project/srt → 混音 / 烧录
 */
import fs from 'node:fs'
import path from 'node:path'
import type {
  ScreenRecordBurnSubtitlesParams,
  ScreenRecordBurnSubtitlesResult,
  ScreenRecordConfig,
} from '../../shared/screen-record'
import { SCREEN_RECORD_SETTINGS_DEFAULTS } from '../../shared/screen-record'
import { isPathUnderDir } from '../preview-path-acl'
import { probeMediaDurationMs } from './audio-duration'
import {
  buildDubFilterArgs,
  buildDubOnlyFilterArgs,
  escapeFfmpegSubtitlesPath,
  resolveBurnFontPath,
} from './narrate-service'
import { buildSubtitleForceStyle, normalizeSubtitleStyle } from './subtitle-style'
import { runFfmpeg, webmToMp4, type FfmpegRunResult } from './ffmpeg-runner'
import { cuesToSrt } from './srt'
import {
  cuesToProjectCues,
  ensureOriginalBackup,
  hashCueText,
  loadSubtitleProject,
  migrateLegacySidecar,
  saveSubtitleProject,
  type SubtitleProjectCue,
} from './subtitle-project'

/** burn 依赖注入 */
export interface BurnSubtitlesServiceDeps {
  resolveRecordingsDir: () => string
  readSettings: () => Promise<
    Pick<ScreenRecordConfig, 'enabled' | 'narrateOriginalAudioGain' | 'exportMp4Default'>
  >
  generateAudioFile?: (text: string, destDir: string) => Promise<string>
  probeDurationMs?: (filePath: string) => Promise<number | null>
  runFfmpeg?: (args: string[], opts?: { cwd?: string }) => Promise<FfmpegRunResult>
  convertWebmToMp4?: (input: string, output: string) => Promise<FfmpegRunResult>
  resolveTempDir?: () => string
}

/**
 * 创建烧录服务（增量配音）。
 */
export function createBurnSubtitlesService(deps: BurnSubtitlesServiceDeps) {
  const probe = deps.probeDurationMs ?? probeMediaDurationMs
  const ffmpeg = deps.runFfmpeg ?? runFfmpeg
  const toMp4 = deps.convertWebmToMp4 ?? webmToMp4

  /**
   * 执行烧录：保存字幕项目后按需增量 TTS 并产出 -burned 成片。
   */
  async function burn(
    params: ScreenRecordBurnSubtitlesParams,
  ): Promise<ScreenRecordBurnSubtitlesResult> {
    const settings = await deps.readSettings()
    if (!settings.enabled) {
      return { ok: false, error: 'disabled' }
    }
    if (!params?.path || typeof params.path !== 'string') {
      return { ok: false, error: 'invalid_cues', message: 'path required' }
    }

    const sourceAbs = path.resolve(params.path)
    const recordingsDir = path.resolve(deps.resolveRecordingsDir())
    if (!isPathUnderDir(sourceAbs, recordingsDir)) {
      return { ok: false, error: 'source_not_in_recordings' }
    }
    if (!fs.existsSync(sourceAbs)) {
      return { ok: false, error: 'source_unavailable', message: 'source file missing' }
    }

    let inputCues: SubtitleProjectCue[]
    if (Array.isArray(params.cues) && params.cues.length > 0) {
      inputCues = cuesToProjectCues(
        params.cues.map((c) => ({
          id: c.id,
          startMs: c.startMs,
          endMs: c.endMs ?? c.startMs + 1,
          text: c.text,
          audioFile: c.audioFile,
        })),
      )
    } else {
      const loaded = loadSubtitleProject(sourceAbs)
      if (!loaded.ok) {
        return { ok: false, error: 'invalid_cues', message: loaded.message }
      }
      if (loaded.cues.length === 0) {
        return { ok: false, error: 'invalid_cues', message: 'cues required' }
      }
      inputCues = loaded.cues
    }

    for (const c of inputCues) {
      if (typeof c.startMs !== 'number' || c.startMs < 0 || !c.text.trim()) {
        return {
          ok: false,
          error: 'invalid_cues',
          message: 'each cue needs startMs>=0 and non-empty text',
        }
      }
    }

    const dub = params.dub !== false
    const subtitleMode = params.subtitleMode ?? 'burn'
    const gain =
      typeof params.originalAudioGain === 'number'
        ? Math.min(1, Math.max(0, params.originalAudioGain))
        : (settings.narrateOriginalAudioGain ??
          SCREEN_RECORD_SETTINGS_DEFAULTS.narrateOriginalAudioGain)

    const paths = migrateLegacySidecar(sourceAbs)
    fs.mkdirSync(paths.cacheDir, { recursive: true })

    // 合并已有 project 中的 audio 元数据（同 id）
    const prev = loadSubtitleProject(sourceAbs)
    const prevById = new Map<string, SubtitleProjectCue>()
    if (prev.ok) {
      for (const c of prev.cues) prevById.set(c.id, c)
    }
    // 未显式传样式时沿用项目里已存的，避免二次烧录丢失用户调好的字号/颜色
    const style = normalizeSubtitleStyle(params.style ?? (prev.ok ? prev.style : undefined))

    const tempDir =
      deps.resolveTempDir?.() ?? path.join(recordingsDir, '_narrate_tmp', `burn-${Date.now()}`)
    fs.mkdirSync(tempDir, { recursive: true })

    let ttsRegenerated = 0
    let ttsReused = 0
    const resolved: SubtitleProjectCue[] = []

    try {
      for (const cue of inputCues) {
        const text = cue.text.trim()
        const nextHash = hashCueText(text)
        const prevCue = prevById.get(cue.id)
        let endMs = cue.endMs > cue.startMs ? cue.endMs : cue.startMs + 1
        let audioFile = cue.audioFile ?? prevCue?.audioFile
        let audioAbs =
          audioFile && fs.existsSync(path.join(paths.cacheDir, audioFile))
            ? path.join(paths.cacheDir, audioFile)
            : null

        const canReuse =
          dub &&
          !!prevCue &&
          prevCue.textHash === nextHash &&
          nextHash === hashCueText(prevCue.text) &&
          !!audioAbs

        if (dub) {
          if (canReuse && audioAbs) {
            ttsReused += 1
          } else {
            if (!deps.generateAudioFile) {
              return { ok: false, error: 'tts_unavailable', message: 'TTS not wired' }
            }
            try {
              const generated = await deps.generateAudioFile(text, tempDir)
              const generatedExt = path.extname(generated).toLowerCase()
              const safeExt = generatedExt === '.mp3' || generatedExt === '.wav' ? generatedExt : '.wav'
              const destName = `${cue.id}${safeExt}`
              const dest = path.join(paths.cacheDir, destName)
              fs.copyFileSync(generated, dest)
              audioFile = destName
              audioAbs = dest
              ttsRegenerated += 1
            } catch (e) {
              return {
                ok: false,
                error: 'tts_unavailable',
                message: e instanceof Error ? e.message : String(e),
              }
            }
            if (endMs <= cue.startMs || cue.endMs == null) {
              const dur = (await probe(audioAbs!)) ?? 1500
              endMs = cue.startMs + Math.max(200, dur)
            }
          }
        } else if (endMs <= cue.startMs) {
          endMs = cue.startMs + Math.max(800, Math.round((text.length / 4) * 1000))
        }

        resolved.push({
          id: cue.id,
          startMs: cue.startMs,
          endMs,
          text,
          textHash: nextHash,
          audioFile: dub ? audioFile : audioFile,
        })
      }

      const saved = saveSubtitleProject(sourceAbs, resolved, style)
      if (!saved.ok) {
        return { ok: false, error: 'write_failed', message: saved.message }
      }

      // 始终以无字幕原片为输入：成片会被就地覆盖，否则重复烧录会字幕叠字幕
      const originalVideo = ensureOriginalBackup(sourceAbs)
      // 中间产物沿用源容器：视频走 copy，容器换成 .webm 会让 H.264 写头失败
      const containerExt = path.extname(originalVideo).toLowerCase() || '.webm'
      const wantMp4 = params.exportMp4 === true
      const outExt = wantMp4 ? '.mp4' : containerExt
      const outPath = path.join(paths.dir, `${paths.stem}${outExt}`)
      let warning: 'subtitle_burn_failed' | 'mp4_failed' | undefined
      let workingVideo = originalVideo

      if (dub) {
        const audioCues = resolved
          .map((c) => {
            if (!c.audioFile) return null
            const p = path.join(paths.cacheDir, c.audioFile)
            if (!fs.existsSync(p)) return null
            return { startMs: c.startMs, audioPath: p }
          })
          .filter((x): x is { startMs: number; audioPath: string } => !!x)
        if (audioCues.length === 0) {
          return { ok: false, error: 'tts_unavailable', message: 'no cue audio' }
        }
        const mixedPath = path.join(tempDir, `mixed${containerExt}`)
        let mixResult = await ffmpeg(buildDubFilterArgs(originalVideo, audioCues, gain, mixedPath))
        if (!mixResult.ok) {
          mixResult = await ffmpeg(buildDubOnlyFilterArgs(originalVideo, audioCues, mixedPath))
        }
        if (!mixResult.ok) {
          return { ok: false, error: 'narrate_failed', message: mixResult.message }
        }
        workingVideo = mixedPath
      }

      if (subtitleMode === 'burn') {
        const srtPath = saved.srtPath
        // 确保 srt 最新
        fs.writeFileSync(srtPath, cuesToSrt(resolved), 'utf8')
        const font = resolveBurnFontPath()
        const esc = escapeFfmpegSubtitlesPath(srtPath)
        const forceStyle = buildSubtitleForceStyle(style)
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
        } else {
          warning = 'subtitle_burn_failed'
        }
      }

      // 覆盖前先把中间产物转成目标容器，失败则退回源容器，避免留下半成品
      let finalPath = outPath
      if (wantMp4 && containerExt !== '.mp4') {
        const mp4Temp = path.join(tempDir, 'final.mp4')
        const r = await toMp4(workingVideo, mp4Temp)
        if (r.ok) {
          workingVideo = mp4Temp
        } else {
          if (!warning) warning = 'mp4_failed'
          finalPath = path.join(paths.dir, `${paths.stem}${containerExt}`)
        }
      }

      fs.copyFileSync(workingVideo, finalPath)
      // 容器变化时旧成片改名了，清掉它，列表里始终只留一个视频
      if (path.resolve(finalPath) !== sourceAbs && fs.existsSync(sourceAbs)) {
        fs.rmSync(sourceAbs, { force: true })
      }

      return {
        ok: true,
        path: finalPath,
        srtPath: saved.srtPath,
        projectPath: saved.projectPath,
        mp4Path: path.extname(finalPath).toLowerCase() === '.mp4' ? finalPath : undefined,
        warning,
        ttsRegenerated,
        ttsReused,
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

  return { burn }
}

export type BurnSubtitlesService = ReturnType<typeof createBurnSubtitlesService>
