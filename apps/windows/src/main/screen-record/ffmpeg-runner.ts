/**
 * 主进程 ffmpeg 封装（WebM→MP4、旁白混流/烧字幕复用）。
 *
 * 可执行文件解析见 `resolveFfmpegExecutable`：环境变量逃生口 → 包内 →
 * 系统 PATH。包内二进制来自 @ffmpeg-installer/ffmpeg；打包需 asarUnpack。
 */
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { resolveCommand } from '@mtbot/agent-runtime'
import { refreshCommonCliPathsInProcessEnv } from '../cli-user-path'
import { createLogger } from '../logger'

const log = createLogger('FfmpegRunner')

export type FfmpegRunResult = { ok: true } | { ok: false; message: string }

/** 可注入依赖，便于单测 mock spawn */
export interface FfmpegRunnerDeps {
  /** 解析 ffmpeg 可执行文件绝对路径 */
  resolveFfmpegPath: () => string
  /** 等价 child_process.spawn */
  spawn: typeof nodeSpawn
}

/** 候选路径集合（纯函数入参，见 selectFfmpegExecutable） */
export interface FfmpegCandidateSet {
  /** 环境变量 LUMII_FFMPEG_PATH 的值（用户显式指定） */
  readonly override?: string
  /** 安装包内 @ffmpeg-installer 的路径；平台包缺失时为 null */
  readonly bundled?: string | null
  /** 系统 PATH 上的 ffmpeg；未找到时为 null */
  readonly system?: string | null
}

/**
 * 纯函数：按「显式指定 → 包内 → 系统」选第一个存在的路径。
 *
 * 拆出来是为了可测（存在性判断由调用方以 fileExists 注入）。
 */
export function selectFfmpegExecutable(
  candidates: FfmpegCandidateSet,
  fileExists: (p: string) => boolean,
): string | null {
  const override = candidates.override?.trim()
  if (override && fileExists(override)) return override
  if (candidates.bundled && fileExists(candidates.bundled)) return candidates.bundled
  if (candidates.system && fileExists(candidates.system)) return candidates.system
  return null
}

/**
 * 解析安装包内 ffmpeg 路径（asar → asar.unpacked 改写）。
 *
 * 平台包缺失时 @ffmpeg-installer 的 index.js 会直接 throw，这里统一为 null。
 */
function tryResolveBundledFfmpegPath(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const installer = require('@ffmpeg-installer/ffmpeg') as { path?: string }
    let p = installer?.path
    if (!p) return null
    if (p.includes(`${path.sep}app.asar${path.sep}`) && !p.includes('app.asar.unpacked')) {
      p = p.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
    }
    return p
  } catch {
    return null
  }
}

/**
 * 系统 PATH 上的 ffmpeg。找不到时 resolveCommand 原样返回命令名（非绝对路径）。
 */
function tryResolveSystemFfmpegPath(): string | null {
  try {
    refreshCommonCliPathsInProcessEnv()
    const { command } = resolveCommand('ffmpeg')
    return path.isAbsolute(command) ? command : null
  } catch {
    return null
  }
}

/**
 * 解析 ffmpeg 可执行文件（设计 D25）：
 * 1. `LUMII_FFMPEG_PATH`（与 LUMII_BROWSER_EXECUTABLE 同一逃生口模式）；
 * 2. 安装包内 @ffmpeg-installer；
 * 3. 系统 PATH 的 ffmpeg（包内是 2018 年的 4.1.0，用户可能想用发行版新版）。
 */
export function resolveFfmpegExecutable(): string {
  const override = process.env.LUMII_FFMPEG_PATH?.trim()
  const selected = selectFfmpegExecutable(
    {
      override,
      bundled: tryResolveBundledFfmpegPath(),
      system: tryResolveSystemFfmpegPath(),
    },
    (p) => fs.existsSync(p),
  )
  if (selected) {
    if (override && selected !== override) {
      log.warn(`LUMII_FFMPEG_PATH 指向的文件不存在，已回退：${override}`)
    }
    return selected
  }
  throw new Error('未找到可用的 ffmpeg：请安装系统 ffmpeg，或用 LUMII_FFMPEG_PATH 指定可执行文件')
}

let runnerDeps: FfmpegRunnerDeps = {
  resolveFfmpegPath: resolveFfmpegExecutable,
  spawn: nodeSpawn,
}

/**
 * 测试注入 spawn / 路径解析（勿在生产调用）。
 */
export function setFfmpegRunnerDepsForTest(partial: Partial<FfmpegRunnerDeps>): void {
  runnerDeps = { ...runnerDeps, ...partial }
}

/**
 * 恢复默认 deps（测试 afterEach）。
 */
export function resetFfmpegRunnerDeps(): void {
  runnerDeps = {
    resolveFfmpegPath: resolveFfmpegExecutable,
    spawn: nodeSpawn,
  }
}

/**
 * 运行 ffmpeg，收集 stderr，非 0 退出码视为失败。
 */
export function runFfmpeg(
  args: string[],
  opts?: { cwd?: string },
): Promise<FfmpegRunResult> {
  return new Promise((resolve) => {
    let bin: string
    try {
      bin = runnerDeps.resolveFfmpegPath()
    } catch (e) {
      resolve({
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      })
      return
    }
    if (!bin || !fs.existsSync(bin)) {
      resolve({ ok: false, message: `ffmpeg not found: ${bin || '(empty)'}` })
      return
    }

    let stderr = ''
    let child: ChildProcessWithoutNullStreams
    try {
      child = runnerDeps.spawn(bin, args, {
        cwd: opts?.cwd,
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams
    } catch (e) {
      resolve({
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      })
      return
    }

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    })
    child.on('error', (err) => {
      resolve({ ok: false, message: err.message })
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true })
        return
      }
      const tail = stderr.trim().slice(-800)
      resolve({
        ok: false,
        message: `ffmpeg exit ${code ?? 'null'}${tail ? `: ${tail}` : ''}`,
      })
    })
  })
}

/**
 * WebM → MP4（H.264 + AAC），失败不删源文件。
 */
export async function webmToMp4(input: string, output: string): Promise<FfmpegRunResult> {
  const absIn = path.resolve(input)
  const absOut = path.resolve(output)
  if (!fs.existsSync(absIn)) {
    return { ok: false, message: `input missing: ${absIn}` }
  }
  return runFfmpeg([
    '-y',
    '-i',
    absIn,
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '23',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    absOut,
  ])
}
