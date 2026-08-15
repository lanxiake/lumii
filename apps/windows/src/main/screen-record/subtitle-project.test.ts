/**
 * 字幕项目 sidecar 读写与成片列表单测
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildBurnedOutputPath,
  buildProjectPaths,
  hashCueText,
  listRecordings,
  loadSubtitleProject,
  saveSubtitleProject,
  cuesToProjectCues,
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
  it('由成片路径推导 sidecar', () => {
    const p = buildProjectPaths('E:/ws/temp/recordings/demo.webm')
    expect(p.stem).toBe('demo')
    expect(p.projectPath.replace(/\\/g, '/')).toMatch(/demo\.lumii-subs\.json$/)
    expect(p.srtPath.replace(/\\/g, '/')).toMatch(/demo\.srt$/)
    expect(p.cacheDir.replace(/\\/g, '/')).toMatch(/demo\.subs-cache$/)
    expect(p.narratedSrtPath.replace(/\\/g, '/')).toMatch(/demo-narrated\.srt$/)
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
    expect(loaded.source).toBe('narrated_srt')
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

describe('buildBurnedOutputPath', () => {
  it('foo.webm → foo-burned.webm', () => {
    expect(buildBurnedOutputPath('E:/a/foo.webm').replace(/\\/g, '/')).toMatch(/foo-burned\.webm$/)
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
    const cacheFile = path.join(rec, 'n.subs-cache', loaded.cues[0]!.audioFile!)
    expect(fs.existsSync(cacheFile)).toBe(true)
  })
})
