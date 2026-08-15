/**
 * 录屏字幕 sidecar 项目：路径、读写、成片列表
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ScreenRecordSubtitleStyle } from '../../shared/screen-record'
import { cuesToSrt, parseSrt, type SrtCue } from './srt'
import { normalizeSubtitleStyle } from './subtitle-style'

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
  /** 字幕外观；旧项目文件没有该字段，读取时按默认补全 */
  style?: ScreenRecordSubtitleStyle
  updatedAt: number
}

/** 旧版散落在 recordings 根目录的 sidecar 路径（仅用于兼容读取与迁移） */
export interface LegacySubtitleProjectPaths {
  projectPath: string
  srtPath: string
  narratedSrtPath: string
  cacheDir: string
}

/** 由成片路径推导的 sidecar 路径集：附属文件统一收纳在 <stem>.lumii-subs 目录内 */
export interface SubtitleProjectPaths {
  stem: string
  dir: string
  /** 附属目录，成片旁边只多这一个文件夹 */
  assetDir: string
  projectPath: string
  srtPath: string
  cacheDir: string
  legacy: LegacySubtitleProjectPaths
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

/** 附属目录后缀；成片旁只多这一个文件夹 */
export const SUBTITLE_ASSET_DIR_SUFFIX = '.lumii-subs'

/** 原片备份在附属目录内的文件名（不含扩展名） */
const ORIGINAL_BASENAME = 'original'

/**
 * 由成片绝对路径推导附属目录及其内部的 project / srt / tts 路径。
 */
export function buildProjectPaths(videoPath: string): SubtitleProjectPaths {
  const abs = path.resolve(videoPath)
  const dir = path.dirname(abs)
  const ext = path.extname(abs)
  const stem = path.basename(abs, ext)
  const assetDir = path.join(dir, `${stem}${SUBTITLE_ASSET_DIR_SUFFIX}`)
  return {
    stem,
    dir,
    assetDir,
    projectPath: path.join(assetDir, 'project.json'),
    srtPath: path.join(assetDir, 'subtitles.srt'),
    cacheDir: path.join(assetDir, 'tts'),
    legacy: {
      projectPath: path.join(dir, `${stem}.lumii-subs.json`),
      srtPath: path.join(dir, `${stem}.srt`),
      narratedSrtPath: path.join(dir, `${stem}-narrated.srt`),
      cacheDir: path.join(dir, `${stem}.subs-cache`),
    },
  }
}

/**
 * 把旧版散落在 recordings 根目录的 sidecar 迁入附属目录。
 * 幂等：目标已存在时直接丢弃旧文件，保证根目录只留成片。
 */
export function migrateLegacySidecar(videoPath: string): SubtitleProjectPaths {
  const paths = buildProjectPaths(videoPath)
  const { legacy } = paths
  const hasLegacy =
    fs.existsSync(legacy.projectPath) ||
    fs.existsSync(legacy.srtPath) ||
    fs.existsSync(legacy.narratedSrtPath) ||
    fs.existsSync(legacy.cacheDir)
  if (!hasLegacy) return paths

  try {
    fs.mkdirSync(paths.cacheDir, { recursive: true })
    moveInto(legacy.projectPath, paths.projectPath)
    moveInto(legacy.srtPath, paths.srtPath)
    moveInto(legacy.narratedSrtPath, paths.srtPath)
    if (fs.existsSync(legacy.cacheDir)) {
      for (const name of fs.readdirSync(legacy.cacheDir)) {
        moveInto(path.join(legacy.cacheDir, name), path.join(paths.cacheDir, name))
      }
      fs.rmSync(legacy.cacheDir, { recursive: true, force: true })
    }
  } catch {
    // 迁移失败不阻断主流程，legacy 回退读取仍然可用
  }
  return paths
}

/**
 * 移动单个文件；目标已存在时丢弃来源，避免旧文件残留在根目录。
 */
function moveInto(from: string, to: string): void {
  if (!fs.existsSync(from)) return
  if (fs.existsSync(to)) {
    fs.rmSync(from, { force: true })
    return
  }
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  fs.rmSync(from, { force: true })
}

/**
 * 查找附属目录内的无字幕原片备份。
 */
export function resolveOriginalVideoPath(videoPath: string): string | null {
  const paths = buildProjectPaths(videoPath)
  if (!fs.existsSync(paths.assetDir)) return null
  for (const name of fs.readdirSync(paths.assetDir)) {
    if (path.basename(name, path.extname(name)) === ORIGINAL_BASENAME) {
      return path.join(paths.assetDir, name)
    }
  }
  return null
}

/**
 * 确保附属目录内存在无字幕原片备份，并返回其路径。
 *
 * 烧录会就地覆盖成片，只有始终以这份原片为输入，重复烧录才不会叠加字幕。
 * 已存在备份时绝不覆盖——那份才是唯一的无字幕素材。
 */
export function ensureOriginalBackup(videoPath: string): string {
  const abs = path.resolve(videoPath)
  const existing = resolveOriginalVideoPath(abs)
  if (existing) return existing

  const paths = buildProjectPaths(abs)
  fs.mkdirSync(paths.assetDir, { recursive: true })
  const dest = path.join(paths.assetDir, `${ORIGINAL_BASENAME}${path.extname(abs) || '.webm'}`)
  fs.copyFileSync(abs, dest)
  return dest
}

export type RestoreOriginalResult =
  | { ok: true; path: string }
  | { ok: false; error: 'source_unavailable' | 'write_failed'; message?: string }

/**
 * 用备份的无字幕原片覆盖当前成片（撤销烧录）。
 */
export function restoreOriginalRecording(videoPath: string): RestoreOriginalResult {
  const abs = path.resolve(videoPath)
  const original = resolveOriginalVideoPath(abs)
  if (!original || !fs.existsSync(original)) {
    return { ok: false, error: 'source_unavailable', message: 'original backup missing' }
  }
  try {
    const paths = buildProjectPaths(abs)
    const dest = path.join(paths.dir, `${paths.stem}${path.extname(original)}`)
    fs.copyFileSync(original, dest)
    // 烧录可能把 webm 转成了 mp4，还原后清掉扩展名不同的旧成片
    if (path.resolve(dest) !== abs && fs.existsSync(abs)) {
      fs.rmSync(abs, { force: true })
    }
    return { ok: true, path: dest }
  } catch (e) {
    return {
      ok: false,
      error: 'write_failed',
      message: e instanceof Error ? e.message : String(e),
    }
  }
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
      hasSrt:
        fs.existsSync(paths.srtPath) ||
        fs.existsSync(paths.legacy.srtPath) ||
        fs.existsSync(paths.legacy.narratedSrtPath),
      hasProject: fs.existsSync(paths.projectPath) || fs.existsSync(paths.legacy.projectPath),
    })
  }

  items.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return items
}

export type DeleteRecordingArtifactsResult =
  | { ok: true; deletedPaths: string[] }
  | { ok: false; error: 'source_unavailable' | 'write_failed'; message?: string }

/**
 * 删除成片及其同名字幕工程、SRT 和 TTS 缓存目录。
 * 调用方必须先校验成片位于 recordings 根目录内。
 */
export function deleteRecordingArtifacts(videoPath: string): DeleteRecordingArtifactsResult {
  const abs = path.resolve(videoPath)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    return { ok: false, error: 'source_unavailable', message: 'video missing' }
  }

  const paths = buildProjectPaths(abs)
  const candidates = [
    abs,
    paths.assetDir,
    paths.legacy.projectPath,
    paths.legacy.srtPath,
    paths.legacy.narratedSrtPath,
    paths.legacy.cacheDir,
  ]
  const deletedPaths: string[] = []
  try {
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue
      fs.rmSync(candidate, { recursive: true, force: true })
      deletedPaths.push(candidate)
    }
    return { ok: true, deletedPaths }
  } catch (e) {
    return {
      ok: false,
      error: 'write_failed',
      message: e instanceof Error ? e.message : String(e),
    }
  }
}

export type LoadSubtitleProjectResult =
  | {
      ok: true
      cues: SubtitleProjectCue[]
      style: ScreenRecordSubtitleStyle
      source: 'project' | 'srt' | 'narrated_srt' | 'empty'
      /** 附属目录内的无字幕原片（若已烧录过） */
      originalPath?: string
    }
  | { ok: false; error: string; message?: string }

/**
 * 加载字幕项目：优先 json，其次 .srt / -narrated.srt。
 */
export function loadSubtitleProject(videoPath: string): LoadSubtitleProjectResult {
  const abs = path.resolve(videoPath)
  if (!fs.existsSync(abs)) {
    return { ok: false, error: 'source_unavailable', message: 'video missing' }
  }
  const paths = migrateLegacySidecar(abs)
  const originalPath = resolveOriginalVideoPath(abs) ?? undefined

  if (fs.existsSync(paths.projectPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(paths.projectPath, 'utf8')) as SubtitleProjectFile
      const cues = Array.isArray(raw.cues) ? raw.cues : []
      return {
        ok: true,
        source: 'project',
        originalPath,
        style: normalizeSubtitleStyle(raw.style),
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

  for (const [srt, source] of [
    [paths.srtPath, 'srt'],
    [paths.legacy.srtPath, 'srt'],
    [paths.legacy.narratedSrtPath, 'narrated_srt'],
  ] as const) {
    if (!fs.existsSync(srt)) continue
    const cues = cuesToProjectCues(parseSrt(fs.readFileSync(srt, 'utf8')))
    return { ok: true, cues, style: normalizeSubtitleStyle(undefined), source, originalPath }
  }
  return {
    ok: true,
    cues: [],
    style: normalizeSubtitleStyle(undefined),
    source: 'empty',
    originalPath,
  }
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
  style?: Partial<ScreenRecordSubtitleStyle>,
): SaveSubtitleProjectResult {
  const abs = path.resolve(videoPath)
  if (!fs.existsSync(abs)) {
    return { ok: false, error: 'source_unavailable', message: 'video missing' }
  }
  const paths = migrateLegacySidecar(abs)
  const normalized = cuesToProjectCues(cues)
  const file: SubtitleProjectFile = {
    version: 1,
    videoPath: abs,
    cues: normalized,
    style: normalizeSubtitleStyle(style),
    updatedAt: Date.now(),
  }
  try {
    fs.mkdirSync(paths.assetDir, { recursive: true })
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
  const paths = migrateLegacySidecar(abs)
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
