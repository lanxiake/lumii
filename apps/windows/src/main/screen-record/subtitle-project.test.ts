/**
 * 字幕项目 sidecar 读写与成片列表单测
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildProjectPaths,
  ensureOriginalBackup,
  hashCueText,
  listRecordings,
  loadSubtitleProject,
  migrateLegacySidecar,
  resolveOriginalVideoPath,
  restoreOriginalRecording,
  saveSubtitleProject,
  cuesToProjectCues,
  deleteRecordingArtifacts,
} from './subtitle-project'

let tmpRoot = ''

/** 创建临时 recordings 目录 */
function makeTmp(): string {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-subs-'))
  const rec = path.join(tmpRoot, 'recordings')
  fs.mkdirSync(rec, { recursive: true })
  return rec
}

afterEach(() => {
  if (tmpRoot && fs.existsSync(tmpRoot)) {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
  tmpRoot = ''
})

describe('hashCueText', () => {
  it('trim 后稳定哈希', () => {
    expect(hashCueText('  hello  ')).toBe(hashCueText('hello'))
    expect(hashCueText('a')).not.toBe(hashCueText('b'))
  })
})

describe('buildProjectPaths', () => {
  it('所有附属文件收敛到单个 <stem>.lumii-subs 目录', () => {
    const p = buildProjectPaths('E:/ws/temp/recordings/demo.webm')
    const norm = (s: string) => s.replace(/\\/g, '/')
    expect(p.stem).toBe('demo')
    expect(norm(p.assetDir)).toMatch(/recordings\/demo\.lumii-subs$/)
    expect(norm(p.projectPath)).toMatch(/demo\.lumii-subs\/project\.json$/)
    expect(norm(p.srtPath)).toMatch(/demo\.lumii-subs\/subtitles\.srt$/)
    expect(norm(p.cacheDir)).toMatch(/demo\.lumii-subs\/tts$/)
  })

  it('保留旧版散落 sidecar 路径以便兼容读取', () => {
    const p = buildProjectPaths('E:/ws/temp/recordings/demo.webm')
    const norm = (s: string) => s.replace(/\\/g, '/')
    expect(norm(p.legacy.projectPath)).toMatch(/recordings\/demo\.lumii-subs\.json$/)
    expect(norm(p.legacy.srtPath)).toMatch(/recordings\/demo\.srt$/)
    expect(norm(p.legacy.narratedSrtPath)).toMatch(/recordings\/demo-narrated\.srt$/)
    expect(norm(p.legacy.cacheDir)).toMatch(/recordings\/demo\.subs-cache$/)
  })
})

describe('migrateLegacySidecar', () => {
  it('把旧版散落文件搬进附属目录且可重复调用', () => {
    const rec = makeTmp()
    const video = path.join(rec, 'old.webm')
    fs.writeFileSync(video, 'v')
    const p = buildProjectPaths(video)
    fs.writeFileSync(p.legacy.projectPath, '{"version":1,"cues":[]}')
    fs.writeFileSync(p.legacy.srtPath, 'srt')
    fs.mkdirSync(p.legacy.cacheDir, { recursive: true })
    fs.writeFileSync(path.join(p.legacy.cacheDir, 'cue.wav'), 'a')

    migrateLegacySidecar(video)
    migrateLegacySidecar(video)

    expect(fs.existsSync(p.projectPath)).toBe(true)
    expect(fs.existsSync(p.srtPath)).toBe(true)
    expect(fs.existsSync(path.join(p.cacheDir, 'cue.wav'))).toBe(true)
    expect(fs.existsSync(p.legacy.projectPath)).toBe(false)
    expect(fs.existsSync(p.legacy.srtPath)).toBe(false)
    expect(fs.existsSync(p.legacy.cacheDir)).toBe(false)
  })
})

describe('ensureOriginalBackup / restoreOriginalRecording', () => {
  it('首次备份无字幕原片，后续调用不覆盖备份', () => {
    const rec = makeTmp()
    const video = path.join(rec, 'clip.mp4')
    fs.writeFileSync(video, 'raw')

    const first = ensureOriginalBackup(video)
    expect(path.basename(first)).toBe('original.mp4')
    expect(fs.readFileSync(first, 'utf8')).toBe('raw')

    // 模拟烧录后可见文件已被字幕版覆盖
    fs.writeFileSync(video, 'burned')
    const second = ensureOriginalBackup(video)
    expect(second).toBe(first)
    expect(fs.readFileSync(second, 'utf8')).toBe('raw')
    expect(resolveOriginalVideoPath(video)).toBe(first)
  })

  it('还原时用原片覆盖可见成片', () => {
    const rec = makeTmp()
    const video = path.join(rec, 'clip.mp4')
    fs.writeFileSync(video, 'raw')
    ensureOriginalBackup(video)
    fs.writeFileSync(video, 'burned')

    const r = restoreOriginalRecording(video)

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.path).toBe(video)
    expect(fs.readFileSync(video, 'utf8')).toBe('raw')
  })

  it('没有备份时还原返回 source_unavailable', () => {
    const rec = makeTmp()
    const video = path.join(rec, 'clip.mp4')
    fs.writeFileSync(video, 'raw')
    const r = restoreOriginalRecording(video)
    expect(r.ok).toBe(false)
  })
})

describe('save/loadSubtitleProject', () => {
  it('写入 json + srt，再 load 回 cues', () => {
    const rec = makeTmp()
    const video = path.join(rec, 'clip.webm')
    fs.writeFileSync(video, 'x')
    const cues = cuesToProjectCues([
      { startMs: 0, endMs: 800, text: '开场' },
      { startMs: 1000, endMs: 2000, text: '结束' },
    ])
    const saved = saveSubtitleProject(video, cues)
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(fs.existsSync(saved.srtPath)).toBe(true)
    expect(fs.existsSync(saved.projectPath)).toBe(true)

    const loaded = loadSubtitleProject(video)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.cues.map((c) => ({ startMs: c.startMs, endMs: c.endMs, text: c.text }))).toEqual([
      { startMs: 0, endMs: 800, text: '开场' },
      { startMs: 1000, endMs: 2000, text: '结束' },
    ])
    expect(loaded.cues[0].textHash).toBe(hashCueText('开场'))
  })

  it('无 project 时回退 parse .srt / -narrated.srt', () => {
    const rec = makeTmp()
    const video = path.join(rec, 'legacy.webm')
    fs.writeFileSync(video, 'x')
    fs.writeFileSync(
      path.join(rec, 'legacy-narrated.srt'),
      '1\n00:00:00,000 --> 00:00:01,000\n旧旁白\n',
    )
    const loaded = loadSubtitleProject(video)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.cues).toHaveLength(1)
    expect(loaded.cues[0].text).toBe('旧旁白')
    expect(loaded.source).not.toBe('empty')
  })
})

describe('listRecordings', () => {
  it('按 mtime 降序；排除 tmp 与 cache 目录内文件', () => {
    const rec = makeTmp()
    const older = path.join(rec, 'a.webm')
    const newer = path.join(rec, 'b.mp4')
    fs.writeFileSync(older, '1')
    fs.writeFileSync(newer, '22')
    const t0 = Date.now() - 10_000
    const t1 = Date.now() - 1_000
    fs.utimesSync(older, new Date(t0), new Date(t0))
    fs.utimesSync(newer, new Date(t1), new Date(t1))

    fs.mkdirSync(path.join(rec, '_narrate_tmp'), { recursive: true })
    fs.writeFileSync(path.join(rec, '_narrate_tmp', 'x.webm'), 'z')
    fs.mkdirSync(path.join(rec, 'b.subs-cache'), { recursive: true })
    fs.writeFileSync(path.join(rec, 'b.subs-cache', 'c1.wav'), 'z')
    fs.writeFileSync(path.join(rec, 'b.srt'), '1\n00:00:00,000 --> 00:00:01,000\nx\n')
    fs.writeFileSync(path.join(rec, 'b.lumii-subs.json'), '{}')

    const list = listRecordings(rec)
    expect(list.map((i) => i.name)).toEqual(['b.mp4', 'a.webm'])
    expect(list[0].hasSrt).toBe(true)
    expect(list[0].hasProject).toBe(true)
    expect(list[1].hasSrt).toBe(false)
    expect(list[0].mtimeMs).toBeGreaterThan(list[1].mtimeMs)
  })
})

describe('deleteRecordingArtifacts', () => {
  it('删除成片、附属目录与旧版散落 sidecar', () => {
    const rec = makeTmp()
    const video = path.join(rec, 'clip.mp4')
    const paths = buildProjectPaths(video)
    fs.writeFileSync(video, 'video')
    fs.mkdirSync(paths.cacheDir, { recursive: true })
    fs.writeFileSync(paths.projectPath, '{}')
    fs.writeFileSync(paths.srtPath, 'subtitle')
    fs.writeFileSync(path.join(paths.cacheDir, 'cue.mp3'), 'audio')
    fs.writeFileSync(paths.legacy.narratedSrtPath, 'subtitle')
    fs.writeFileSync(path.join(rec, 'other.mp4'), 'keep')

    const result = deleteRecordingArtifacts(video)

    expect(result.ok).toBe(true)
    expect(fs.existsSync(video)).toBe(false)
    expect(fs.existsSync(paths.assetDir)).toBe(false)
    expect(fs.existsSync(paths.legacy.narratedSrtPath)).toBe(false)
    expect(fs.existsSync(path.join(rec, 'other.mp4'))).toBe(true)
  })
})

describe('persistResolvedCuesAsProject', () => {
  it('复制临时音频到 cache 并写 project', async () => {
    const { persistResolvedCuesAsProject } = await import('./subtitle-project')
    const rec = makeTmp()
    const video = path.join(rec, 'n.webm')
    fs.writeFileSync(video, 'x')
    const tmpAudio = path.join(rec, 'tmp.wav')
    fs.writeFileSync(tmpAudio, 'audio')
    const r = persistResolvedCuesAsProject(video, [
      { startMs: 0, endMs: 500, text: 'hi', audioPath: tmpAudio },
    ])
    expect(r.ok).toBe(true)
    const loaded = loadSubtitleProject(video)
    expect(loaded.ok).toBe(true)
    if (!loaded.ok) return
    expect(loaded.cues[0]?.audioFile).toBeTruthy()
    const cacheFile = path.join(buildProjectPaths(video).cacheDir, loaded.cues[0]!.audioFile!)
    expect(fs.existsSync(cacheFile)).toBe(true)
  })
})
