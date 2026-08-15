/**
 * 录屏字幕 sidecar 项目：路径、读写、成片列表
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { cuesToSrt, parseSrt, type SrtCue } from './srt'

/** 项目内单条 cue（含增量 TTS 元数据） */
export interface SubtitleProjectCue {
  id: string
  startMs: number
  endMs: number
  text: string
  textHash: string
  /** 相对 cacheDir 的文件名 */
  audioFile?: string
}

/** lumii-subs.json 结构 */
export interface SubtitleProjectFile {
  version: 1
  videoPath?: string
  cues: SubtitleProjectCue[]
  updatedAt: number
}

/** 由成片路径推导的 sidecar 路径集 */
export interface SubtitleProjectPaths {
  stem: string
  dir: string
  projectPath: string
  srtPath: string
  narratedSrtPath: string
  cacheDir: string
}

/** 成片列表项 */
export interface RecordingListItem {
  path: string
  name: string
  bytes: number
  mtimeMs: number
  hasSrt: boolean
  hasProject: boolean
}

/**
 * 规范化文案并计算短哈希（增量 TTS 比对用）。
 */
export function hashCueText(text: string): string {
  return crypto.createHash('sha256').update(text.trim(), 'utf8').digest('hex').slice(0, 16)
}

/**
 * 由成片绝对路径推导 project / srt / cache 路径。
 */
export function buildProjectPaths(videoPath: string): SubtitleProjectPaths {
  const abs = path.resolve(videoPath)
  const dir = path.dirname(abs)
  const ext = path.extname(abs)
  const stem = path.basename(abs, ext)
  return {
    stem,
    dir,
    projectPath: path.join(dir, `${stem}.lumii-subs.json`),
    srtPath: path.join(dir, `${stem}.srt`),
    narratedSrtPath: path.join(dir, `${stem}-narrated.srt`),
    cacheDir: path.join(dir, `${stem}.subs-cache`),
  }
}

/**
 * 烧录输出路径：foo.webm → foo-burned.webm
 */
export function buildBurnedOutputPath(sourcePath: string): string {
  const dir = path.dirname(sourcePath)
  const ext = path.extname(sourcePath) || '.webm'
  const base = path.basename(sourcePath, ext)
  return path.join(dir, `${base}-burned${ext}`)
}

/**
 * 为简单 SrtCue 生成带 id/hash 的 project cues。
 */
export function cuesToProjectCues(
  cues: Array<Pick<SrtCue, 'startMs' | 'endMs' | 'text'> & { id?: string; audioFile?: string }>,
): SubtitleProjectCue[] {
  return cues.map((c, i) => {
    const text = (c.text ?? '').trim()
    const start = Math.max(0, c.startMs)
    const end = c.endMs > start ? c.endMs : start + 1
    return {
      id: c.id ?? `cue_${i + 1}_${hashCueText(`${start}:${text}`).slice(0, 8)}`,
      startMs: start,
      endMs: end,
      text,
      textHash: hashCueText(text),
      audioFile: c.audioFile,
    }
  })
}

/**
 * 扫描 recordings 目录下的成片（webm/mp4），mtime 降序。
 */
export function listRecordings(recordingsDir: string): RecordingListItem[] {
  const root = path.resolve(recordingsDir)
  if (!fs.existsSync(root)) return []

  const entries = fs.readdirSync(root, { withFileTypes: true })
  const items: RecordingListItem[] = []

  for (const ent of entries) {
    if (!ent.isFile()) continue
    const name = ent.name
    const lower = name.toLowerCase()
    if (!lower.endsWith('.webm') && !lower.endsWith('.mp4')) continue
    // 跳过明显中间产物命名（可选；burned/narrated 仍展示以便二次编辑）
    const full = path.join(root, name)
    const st = fs.statSync(full)
    const paths = buildProjectPaths(full)
    items.push({
      path: full,
      name,
      bytes: st.size,
      mtimeMs: st.mtimeMs,
      hasSrt: fs.existsSync(paths.srtPath) || fs.existsSync(paths.narratedSrtPath),
      hasProject: fs.existsSync(paths.projectPath),
    })
  }

  items.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return items
}

export type LoadSubtitleProjectResult =
  | { ok: true; cues: SubtitleProjectCue[]; source: 'project' | 'srt' | 'narrated_srt' | 'empty' }
  | { ok: false; error: string; message?: string }

/**
 * 加载字幕项目：优先 json，其次 .srt / -narrated.srt。
 */
export function loadSubtitleProject(videoPath: string): LoadSubtitleProjectResult {
  const abs = path.resolve(videoPath)
  if (!fs.existsSync(abs)) {
    return { ok: false, error: 'source_unavailable', message: 'video missing' }
  }
  const paths = buildProjectPaths(abs)

  if (fs.existsSync(paths.projectPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(paths.projectPath, 'utf8')) as SubtitleProjectFile
      const cues = Array.isArray(raw.cues) ? raw.cues : []
      return {
        ok: true,
        source: 'project',
        cues: cues.map((c, i) => ({
          id: typeof c.id === 'string' ? c.id : `cue_${i + 1}`,
          startMs: Number(c.startMs) || 0,
          endMs: Number(c.endMs) || 0,
          text: String(c.text ?? ''),
          textHash: typeof c.textHash === 'string' ? c.textHash : hashCueText(String(c.text ?? '')),
          audioFile: typeof c.audioFile === 'string' ? c.audioFile : undefined,
        })),
      }
    } catch (e) {
      return {
        ok: false,
        error: 'invalid_cues',
        message: e instanceof Error ? e.message : String(e),
      }
    }
  }

  if (fs.existsSync(paths.srtPath)) {
    const cues = cuesToProjectCues(parseSrt(fs.readFileSync(paths.srtPath, 'utf8')))
    return { ok: true, cues, source: 'srt' }
  }
  if (fs.existsSync(paths.narratedSrtPath)) {
    const cues = cuesToProjectCues(parseSrt(fs.readFileSync(paths.narratedSrtPath, 'utf8')))
    return { ok: true, cues, source: 'narrated_srt' }
  }
  return { ok: true, cues: [], source: 'empty' }
}

export type SaveSubtitleProjectResult =
  | { ok: true; projectPath: string; srtPath: string }
  | { ok: false; error: string; message?: string }

/**
 * 保存字幕项目：写 lumii-subs.json + 旁路 .srt（不烧录）。
 */
export function saveSubtitleProject(
  videoPath: string,
  cues: SubtitleProjectCue[],
): SaveSubtitleProjectResult {
  const abs = path.resolve(videoPath)
  if (!fs.existsSync(abs)) {
    return { ok: false, error: 'source_unavailable', message: 'video missing' }
  }
  const paths = buildProjectPaths(abs)
  const normalized = cuesToProjectCues(cues)
  const file: SubtitleProjectFile = {
    version: 1,
    videoPath: abs,
    cues: normalized,
    updatedAt: Date.now(),
  }
  try {
    fs.writeFileSync(paths.projectPath, JSON.stringify(file, null, 2), 'utf8')
    fs.writeFileSync(paths.srtPath, cuesToSrt(normalized), 'utf8')
    return { ok: true, projectPath: paths.projectPath, srtPath: paths.srtPath }
  } catch (e) {
    return {
      ok: false,
      error: 'write_failed',
      message: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * 将旁白管线解析后的 cues（含临时 audioPath）持久化为 sidecar 项目，供编辑器续改。
 */
export function persistResolvedCuesAsProject(
  videoPath: string,
  cues: Array<{ startMs: number; endMs: number; text: string; audioPath?: string }>,
): SaveSubtitleProjectResult {
  const abs = path.resolve(videoPath)
  if (!fs.existsSync(abs)) {
    return { ok: false, error: 'source_unavailable', message: 'video missing' }
  }
  const paths = buildProjectPaths(abs)
  try {
    fs.mkdirSync(paths.cacheDir, { recursive: true })
    const projectCues: SubtitleProjectCue[] = cues.map((c, i) => {
      const text = (c.text ?? '').trim()
      const id = `cue_${i + 1}_${hashCueText(`${c.startMs}:${text}`).slice(0, 8)}`
      let audioFile: string | undefined
      if (c.audioPath && fs.existsSync(c.audioPath)) {
        const ext = path.extname(c.audioPath) || '.wav'
        audioFile = `${id}${ext}`
        fs.copyFileSync(c.audioPath, path.join(paths.cacheDir, audioFile))
      }
      return {
        id,
        startMs: c.startMs,
        endMs: c.endMs > c.startMs ? c.endMs : c.startMs + 1,
        text,
        textHash: hashCueText(text),
        audioFile,
      }
    })
    return saveSubtitleProject(abs, projectCues)
  } catch (e) {
    return {
      ok: false,
      error: 'write_failed',
      message: e instanceof Error ? e.message : String(e),
    }
  }
}
