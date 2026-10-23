/**
 * burn-subtitles 增量 TTS 单测
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildProjectPaths,
  hashCueText,
  loadSubtitleProject,
  resolveOriginalVideoPath,
  saveSubtitleProject,
  cuesToProjectCues,
} from './subtitle-project'
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
      expect(r.path).toBe(video)
      expect(r.ttsRegenerated).toBe(1)
      expect(r.ttsReused).toBe(1)
    }
  })

  it('就地覆盖成片，不产生 -burned 副本，并备份无字幕原片', async () => {
    const video = path.join(recordingsDir, 'clip.webm')
    const svc = createBurnSubtitlesService({
      resolveRecordingsDir: () => recordingsDir,
      readSettings: async () => ({
        enabled: true,
        narrateOriginalAudioGain: 0.35,
        exportMp4Default: false,
      }),
      resolveTempDir: () => tempDir,
      runFfmpeg: async (args) => {
        fs.writeFileSync(args[args.length - 1]!, Buffer.from('burned-bytes'))
        return { ok: true as const }
      },
    })

    const r = await svc.burn({
      path: video,
      cues: [{ startMs: 0, endMs: 1000, text: '字幕' }],
      dub: false,
      subtitleMode: 'burn',
    })

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.path).toBe(video)
    expect(fs.readFileSync(video, 'utf8')).toBe('burned-bytes')
    expect(fs.readdirSync(recordingsDir).filter((n) => n.includes('-burned'))).toEqual([])
    expect(fs.readFileSync(resolveOriginalVideoPath(video)!, 'utf8')).toBe('fake-webm')
  })

  it('二次烧录仍以备份原片为输入，避免字幕叠字幕', async () => {
    const video = path.join(recordingsDir, 'clip.webm')
    const inputs: string[] = []
    const svc = createBurnSubtitlesService({
      resolveRecordingsDir: () => recordingsDir,
      readSettings: async () => ({
        enabled: true,
        narrateOriginalAudioGain: 0.35,
        exportMp4Default: false,
      }),
      resolveTempDir: () => tempDir,
      runFfmpeg: async (args) => {
        inputs.push(args[args.indexOf('-i') + 1]!)
        fs.writeFileSync(args[args.length - 1]!, Buffer.from('burned-bytes'))
        return { ok: true as const }
      },
    })
    const params = {
      path: video,
      cues: [{ startMs: 0, endMs: 1000, text: '字幕' }],
      dub: false,
      subtitleMode: 'burn' as const,
    }

    await svc.burn(params)
    await svc.burn(params)

    const original = resolveOriginalVideoPath(video)!
    expect(inputs).toHaveLength(2)
    expect(inputs.every((i) => path.resolve(i) === path.resolve(original))).toBe(true)
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
    expect(fs.existsSync(buildProjectPaths(video).srtPath)).toBe(true)
  })

  it('烧录时按样式覆盖 libass 默认字号与颜色', async () => {
    const video = path.join(recordingsDir, 'clip.webm')
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
      runFfmpeg: run,
    })

    const r = await svc.burn({
      path: video,
      cues: [{ startMs: 0, endMs: 1000, text: '样式' }],
      dub: false,
      subtitleMode: 'burn',
      style: { fontSize: 44, primaryColor: '#FFCC00', outline: 3 },
    })

    expect(r.ok).toBe(true)
    const vfArg = run.mock.calls.flatMap((c) => c[0]).find((a) => a.startsWith('subtitles='))
    expect(vfArg).toBeDefined()
    expect(vfArg).toContain('FontSize=44')
    expect(vfArg).toContain('PrimaryColour=&H0000CCFF')
    expect(vfArg).toContain('Outline=3')
  })

  it('样式随字幕项目持久化，下次加载沿用', async () => {
    const video = path.join(recordingsDir, 'clip.webm')
    const svc = createBurnSubtitlesService({
      resolveRecordingsDir: () => recordingsDir,
      readSettings: async () => ({
        enabled: true,
        narrateOriginalAudioGain: 0.35,
        exportMp4Default: false,
      }),
      resolveTempDir: () => tempDir,
      runFfmpeg: async () => ({ ok: true as const }),
    })
    await svc.burn({
      path: video,
      cues: [{ startMs: 0, endMs: 1000, text: '样式' }],
      dub: false,
      subtitleMode: 'burn',
      style: { fontSize: 44, primaryColor: '#FFCC00', outline: 3 },
    })

    const loaded = loadSubtitleProject(video)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.style).toEqual({ fontSize: 44, primaryColor: '#FFCC00', outline: 3 })
  })

  it('源为 MP4 时中间文件沿用 .mp4 容器，避免 H.264 写入 WebM 失败', async () => {
    const video = path.join(recordingsDir, 'clip.mp4')
    fs.writeFileSync(video, Buffer.from('fake-mp4'))
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
      generateAudioFile: async (_text, destDir) => {
        const p = path.join(destDir, 'tts.wav')
        fs.writeFileSync(p, Buffer.from('a'))
        return p
      },
      probeDurationMs: async () => 400,
      runFfmpeg: run,
    })

    const r = await svc.burn({
      path: video,
      cues: [{ id: 'c1', startMs: 0, endMs: 1000, text: '配音' }],
      dub: true,
      subtitleMode: 'burn',
    })

    expect(r.ok).toBe(true)
    const outputs = run.mock.calls.map((c) => c[0][c[0].length - 1]!)
    expect(outputs.every((o) => !o.endsWith('.webm'))).toBe(true)
    expect(outputs.some((o) => o.endsWith('mixed.mp4'))).toBe(true)
    expect(outputs.some((o) => o.endsWith('burned.mp4'))).toBe(true)
  })

  it('保留 TTS 生成文件的真实扩展名供 ffmpeg 与缓存复用', async () => {
    const video = path.join(recordingsDir, 'clip.webm')
    const tts = vi.fn(async (_text: string, destDir: string) => {
      const generated = path.join(destDir, 'edge-tts.mp3')
      fs.writeFileSync(generated, Buffer.from('mp3'))
      return generated
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
      runFfmpeg: run,
    })

    const result = await svc.burn({
      path: video,
      cues: [{ id: 'c1', startMs: 0, endMs: 1000, text: '配音' }],
      dub: true,
      subtitleMode: 'soft',
    })

    expect(result.ok).toBe(true)
    expect(fs.existsSync(path.join(buildProjectPaths(video).cacheDir, 'c1.mp3'))).toBe(true)
  })
})
