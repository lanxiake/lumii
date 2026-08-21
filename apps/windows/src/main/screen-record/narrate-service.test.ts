/**
 * narrate-service 单测（mock TTS + ffmpeg）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildDubFilterArgs,
  createNarrateService,
  escapeFfmpegSubtitlesPath,
} from './narrate-service'
import { buildProjectPaths, resolveOriginalVideoPath } from './subtitle-project'

describe('escapeFfmpegSubtitlesPath', () => {
  it('转义盘符冒号', () => {
    expect(escapeFfmpegSubtitlesPath('E:\\rec\\a.srt')).toBe('E\\:/rec/a.srt')
  })
})

describe('buildDubFilterArgs', () => {
  it('含 volume + adelay + amix', () => {
    const args = buildDubFilterArgs(
      'E:/r/a.webm',
      [{ startMs: 1000, endMs: 3000, audioPath: 'E:/t/1.wav' }],
      0.35,
      'E:/r/out.webm',
    )
    const fc = args[args.indexOf('-filter_complex') + 1]!
    expect(fc).toContain('volume=0.35')
    expect(fc).toContain('adelay=1000|1000')
    expect(fc).toContain('amix=')
  })

  it('按输出容器选音频编码：webm→libopus，mp4→aac', () => {
    const webm = buildDubFilterArgs(
      'E:/r/a.webm',
      [{ startMs: 0, endMs: 2000, audioPath: 'E:/t/1.wav' }],
      0.35,
      'E:/r/out.webm',
    )
    expect(webm[webm.indexOf('-c:a') + 1]).toBe('libopus')

    // MP4 容器不接受 opus 之外还要求视频可 copy，音频须用 aac
    const mp4 = buildDubFilterArgs(
      'E:/r/a.mp4',
      [{ startMs: 0, endMs: 2000, audioPath: 'E:/t/1.wav' }],
      0.35,
      'E:/r/out.mp4',
    )
    expect(mp4[mp4.indexOf('-c:a') + 1]).toBe('aac')
  })
})

describe('createNarrateService', () => {
  let recordingsDir: string
  let tempDir: string

  beforeEach(() => {
    recordingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-rec-'))
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-nar-'))
    fs.writeFileSync(path.join(recordingsDir, 'clip.webm'), Buffer.from('fake-webm'))
  })

  afterEach(() => {
    fs.rmSync(recordingsDir, { recursive: true, force: true })
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('path 不在 recordings → source_not_in_recordings', async () => {
    const svc = createNarrateService({
      resolveRecordingsDir: () => recordingsDir,
      readSettings: async () => ({
        enabled: true,
        narrateOriginalAudioGain: 0.35,
        exportMp4Default: false,
      }),
      resolveTempDir: () => tempDir,
    })
    const r = await svc.narrate({
      path: path.join(os.tmpdir(), 'outside.webm'),
      cues: [{ startMs: 0, text: 'hi' }],
      dub: false,
      writeSrt: true,
      subtitleMode: 'soft',
    })
    expect(r).toMatchObject({ ok: false, error: 'source_not_in_recordings' })
  })

  it('空 cues → invalid_cues', async () => {
    const svc = createNarrateService({
      resolveRecordingsDir: () => recordingsDir,
      readSettings: async () => ({
        enabled: true,
        narrateOriginalAudioGain: 0.35,
        exportMp4Default: false,
      }),
    })
    const r = await svc.narrate({
      path: path.join(recordingsDir, 'clip.webm'),
      cues: [],
    })
    expect(r).toMatchObject({ ok: false, error: 'invalid_cues' })
  })

  it('dub 但无 TTS → tts_unavailable', async () => {
    const svc = createNarrateService({
      resolveRecordingsDir: () => recordingsDir,
      readSettings: async () => ({
        enabled: true,
        narrateOriginalAudioGain: 0.35,
        exportMp4Default: false,
      }),
      resolveTempDir: () => tempDir,
    })
    const r = await svc.narrate({
      path: path.join(recordingsDir, 'clip.webm'),
      cues: [{ startMs: 0, text: '你好' }],
      dub: true,
    })
    expect(r).toMatchObject({ ok: false, error: 'tts_unavailable' })
  })

  it('soft + 无配音：就地覆盖成片并写出附属目录内的 srt/project', async () => {
    const run = vi.fn(async () => ({ ok: true as const }))
    const svc = createNarrateService({
      resolveRecordingsDir: () => recordingsDir,
      readSettings: async () => ({
        enabled: true,
        narrateOriginalAudioGain: 0.35,
        exportMp4Default: false,
      }),
      resolveTempDir: () => tempDir,
      runFfmpeg: run,
    })
    const src = path.join(recordingsDir, 'clip.webm')
    const r = await svc.narrate({
      path: src,
      cues: [{ startMs: 0, endMs: 1000, text: '你好' }],
      dub: false,
      writeSrt: true,
      subtitleMode: 'soft',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.path).toBe(src)
      expect(fs.existsSync(r.path)).toBe(true)
      expect(r.srtPath && fs.existsSync(r.srtPath)).toBe(true)
      expect(fs.readFileSync(r.srtPath!, 'utf8')).toContain('你好')
      // sidecar 项目供编辑器续改，且全部收在附属目录内
      const paths = buildProjectPaths(src)
      expect(fs.existsSync(paths.projectPath)).toBe(true)
      expect(fs.existsSync(paths.srtPath)).toBe(true)
      expect(fs.readdirSync(recordingsDir).filter((n) => n.includes('-narrated'))).toEqual([])
      expect(r).toMatchObject({
        dubbed: false,
        burned: false,
        bytes: expect.any(Number),
        projectDir: expect.stringContaining('.lumii-subs'),
        ttsCount: 0,
      })
      expect(r.message).toMatch(/就地|覆盖|成片/)
    }
    expect(run).not.toHaveBeenCalled()
  })

  it('burn 失败时 warning=subtitle_burn_failed 仍产出成片', async () => {
    const audio = path.join(tempDir, 'a.wav')
    fs.writeFileSync(audio, Buffer.from('x'))
    const run = vi.fn(async (args: string[]) => {
      const out = args[args.length - 1]!
      if (String(args).includes('subtitles=')) {
        return { ok: false as const, message: 'no font' }
      }
      // 混音：写出假文件
      fs.writeFileSync(out, Buffer.from('mixed'))
      return { ok: true as const }
    })
    const svc = createNarrateService({
      resolveRecordingsDir: () => recordingsDir,
      readSettings: async () => ({
        enabled: true,
        narrateOriginalAudioGain: 0.35,
        exportMp4Default: false,
      }),
      resolveTempDir: () => tempDir,
      generateAudioFile: async () => audio,
      probeDurationMs: async () => 500,
      runFfmpeg: run,
    })
    const r = await svc.narrate({
      path: path.join(recordingsDir, 'clip.webm'),
      cues: [{ startMs: 0, text: '旁白' }],
      dub: true,
      writeSrt: true,
      subtitleMode: 'burn',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.warning).toBe('subtitle_burn_failed')
      expect(fs.existsSync(r.path)).toBe(true)
      expect(r.dubbed).toBe(true)
      expect(r.burned).toBe(false)
      expect(r.ttsCount).toBe(1)
      expect(r.originalPath).toEqual(expect.stringContaining('original.'))
    }
  })

  it('配音就地覆盖成片，并备份无字幕原片', async () => {
    const audio = path.join(tempDir, 'a.wav')
    fs.writeFileSync(audio, Buffer.from('x'))
    const src = path.join(recordingsDir, 'clip.webm')
    const svc = createNarrateService({
      resolveRecordingsDir: () => recordingsDir,
      readSettings: async () => ({
        enabled: true,
        narrateOriginalAudioGain: 0.35,
        exportMp4Default: false,
      }),
      resolveTempDir: () => tempDir,
      generateAudioFile: async () => audio,
      probeDurationMs: async () => 500,
      runFfmpeg: async (args) => {
        fs.writeFileSync(args[args.length - 1]!, Buffer.from('narrated'))
        return { ok: true as const }
      },
    })

    const r = await svc.narrate({
      path: src,
      cues: [{ startMs: 0, text: '旁白' }],
      dub: true,
      writeSrt: true,
      subtitleMode: 'burn',
    })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.path).toBe(src)
    expect(fs.readFileSync(src, 'utf8')).toBe('narrated')
    expect(fs.readFileSync(resolveOriginalVideoPath(src)!, 'utf8')).toBe('fake-webm')
    expect(r).toMatchObject({
      dubbed: true,
      burned: true,
      bytes: expect.any(Number),
      ttsCount: 1,
      originalPath: expect.stringContaining('original.'),
      projectDir: expect.stringContaining('.lumii-subs'),
    })
    expect(r.message).toMatch(/就地|覆盖|\*-narrated/)
  })
})
