/**
 * narrate-service 单测（mock TTS + ffmpeg）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildDubFilterArgs,
  buildNarratedOutputPath,
  createNarrateService,
  escapeFfmpegSubtitlesPath,
} from './narrate-service'

describe('escapeFfmpegSubtitlesPath / buildNarratedOutputPath', () => {
  it('转义盘符冒号', () => {
    expect(escapeFfmpegSubtitlesPath('E:\\rec\\a.srt')).toBe('E\\:/rec/a.srt')
  })

  it('生成 -narrated 文件名', () => {
    expect(buildNarratedOutputPath('E:/r/foo.webm').replace(/\\/g, '/')).toBe('E:/r/foo-narrated.webm')
  })
})

describe('buildDubFilterArgs', () => {
  it('含 volume + adelay + amix', () => {
    const args = buildDubFilterArgs(
      'E:/r/a.webm',
      [{ startMs: 1000, audioPath: 'E:/t/1.wav' }],
      0.35,
      'E:/r/out.webm',
    )
    const fc = args[args.indexOf('-filter_complex') + 1]!
    expect(fc).toContain('volume=0.35')
    expect(fc).toContain('adelay=1000|1000')
    expect(fc).toContain('amix=')
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

  it('soft + 无配音：写出 srt 与 narrated 副本', async () => {
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
      expect(fs.existsSync(r.path)).toBe(true)
      expect(r.srtPath && fs.existsSync(r.srtPath)).toBe(true)
      expect(fs.readFileSync(r.srtPath!, 'utf8')).toContain('你好')
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
    }
  })
})
