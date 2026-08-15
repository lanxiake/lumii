/**
 * burn-subtitles 增量 TTS 单测
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hashCueText, saveSubtitleProject, cuesToProjectCues } from './subtitle-project'
import { createBurnSubtitlesService } from './burn-subtitles-service'

describe('createBurnSubtitlesService', () => {
  let recordingsDir: string
  let tempDir: string

  beforeEach(() => {
    recordingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-burn-rec-'))
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-burn-tmp-'))
    fs.writeFileSync(path.join(recordingsDir, 'clip.webm'), Buffer.from('fake-webm'))
  })

  afterEach(() => {
    fs.rmSync(recordingsDir, { recursive: true, force: true })
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('仅对文案变更的 cue 调用 TTS', async () => {
    const video = path.join(recordingsDir, 'clip.webm')
    const cues = cuesToProjectCues([
      { id: 'c1', startMs: 0, endMs: 800, text: '保留' },
      { id: 'c2', startMs: 1000, endMs: 2000, text: '旧文' },
    ])
    // 预置 c1 缓存音频
    const cacheDir = path.join(recordingsDir, 'clip.subs-cache')
    fs.mkdirSync(cacheDir, { recursive: true })
    const cached = 'c1.wav'
    fs.writeFileSync(path.join(cacheDir, cached), Buffer.from('cached-audio'))
    cues[0].audioFile = cached
    cues[0].textHash = hashCueText('保留')
    saveSubtitleProject(video, cues)

    const tts = vi.fn(async (text: string, destDir: string) => {
      const p = path.join(destDir, `tts-${text}.wav`)
      fs.writeFileSync(p, Buffer.from(`tts-${text}`))
      return p
    })
    const run = vi.fn(async (args: string[]) => {
      const out = args[args.length - 1]!
      fs.writeFileSync(out, Buffer.from('out'))
      return { ok: true as const }
    })

    const svc = createBurnSubtitlesService({
      resolveRecordingsDir: () => recordingsDir,
      readSettings: async () => ({
        enabled: true,
        narrateOriginalAudioGain: 0.35,
        exportMp4Default: false,
      }),
      resolveTempDir: () => tempDir,
      generateAudioFile: tts,
      probeDurationMs: async () => 400,
      runFfmpeg: run,
    })

    const r = await svc.burn({
      path: video,
      cues: [
        { id: 'c1', startMs: 0, endMs: 800, text: '保留' },
        { id: 'c2', startMs: 1000, endMs: 2000, text: '新文' },
      ],
      dub: true,
      subtitleMode: 'soft',
    })
    expect(r.ok).toBe(true)
    expect(tts).toHaveBeenCalledTimes(1)
    expect(tts.mock.calls[0]![0]).toBe('新文')
    if (r.ok) {
      expect(r.path).toMatch(/clip-burned\.webm$/)
      expect(r.ttsRegenerated).toBe(1)
      expect(r.ttsReused).toBe(1)
    }
  })

  it('dub=false 时不调用 TTS，仍写 srt/project 与 burned 副本', async () => {
    const video = path.join(recordingsDir, 'clip.webm')
    const tts = vi.fn()
    const svc = createBurnSubtitlesService({
      resolveRecordingsDir: () => recordingsDir,
      readSettings: async () => ({
        enabled: true,
        narrateOriginalAudioGain: 0.35,
        exportMp4Default: false,
      }),
      resolveTempDir: () => tempDir,
      generateAudioFile: tts,
      runFfmpeg: async () => ({ ok: true as const }),
    })
    const r = await svc.burn({
      path: video,
      cues: [{ startMs: 0, endMs: 1000, text: '仅字幕' }],
      dub: false,
      subtitleMode: 'soft',
    })
    expect(r.ok).toBe(true)
    expect(tts).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(recordingsDir, 'clip.srt'))).toBe(true)
  })
})
