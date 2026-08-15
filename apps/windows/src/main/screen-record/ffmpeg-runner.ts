/**
 * 主进程 ffmpeg 封装（WebM→MP4、旁白混流/烧字幕复用）。
 * 二进制来自 @ffmpeg-installer/ffmpeg；打包需 asarUnpack。
 */
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export type FfmpegRunResult = { ok: true } | { ok: false; message: string }

/** 可注入依赖，便于单测 mock spawn */
export interface FfmpegRunnerDeps {
  /** 解析 ffmpeg 可执行文件绝对路径 */
  resolveFfmpegPath: () => string
  /** 等价 child_process.spawn */
  spawn: typeof nodeSpawn
}

/**
 * 解析安装包内 ffmpeg 路径，并把 asar 路径改写为 asar.unpacked。
 */
export function resolvePackagedFfmpegPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const installer = require('@ffmpeg-installer/ffmpeg') as { path: string }
  let p = installer.path
  if (p.includes(`${path.sep}app.asar${path.sep}`) && !p.includes('app.asar.unpacked')) {
    p = p.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
  }
  return p
}

let runnerDeps: FfmpegRunnerDeps = {
  resolveFfmpegPath: resolvePackagedFfmpegPath,
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
    resolveFfmpegPath: resolvePackagedFfmpegPath,
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
